import { API } from '$lib/API.js';
import type { DomainUser } from 'missiv-common';
import { derived, type Readable } from 'svelte/store';

type Signer = { address: `0x${string}`; privateKey: string; publicKey: string };
type AccountWithSigner = { address: `0x${string}`; signer: Signer };
export type Account = AccountWithSigner | { address: `0x${string}`; signer: undefined } | undefined;
export type AccountStore = Readable<Account>;

export type MissivRegistration = { error?: { message: string; cause?: any } } & (
	| {
			// Default State, no Account to fetch registration status for
			step: 'Idle';
			domain: string;
	  }
	| {
			// Account is Available, Fetching registration status
			step: 'Fetching';
			domain: string;
			address: `0x${string}`;
			signer: Signer;
	  }
	| {
			// Account is Available, but not registered yet
			step: 'Unregistered';
			domain: string;
			registering: boolean; // can be registering
			address: `0x${string}`;
			signer: Signer;
	  }
	| {
			// Account is Available and registered
			step: 'Registered';
			domain: string;
			editing: boolean; // can be editing
			address: `0x${string}`;
			signer: Signer;
			user: CompleteUser;
	  }
);

/** @deprecated the domain user is the whole user now: use `DomainUser` */
export type CompleteUser = DomainUser;

export function createMissivRegistration(params: {
	endpoint: string;
	domain: string;
	/**
	 * the app's origin, which the wallet's publication signature names (its host is
	 * `domain`); defaults to the page's origin in a browser
	 */
	appOrigin?: string;
	account: Readable<Account>;
}) {
	const api: API = new API(params.endpoint);
	const appOrigin =
		params.appOrigin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);

	let $missivRegistration: MissivRegistration = {
		step: 'Idle',
		domain: params.domain
	};
	let _set: (value: MissivRegistration) => void;
	let _account: Account | undefined;

	async function getRegisteredUser(address: `0x${string}`): Promise<CompleteUser | undefined> {
		const { domainUser } = await api.getDomainUser({
			type: 'getDomainUser',
			address: address,
			domain: params.domain
		});
		return domainUser;
	}

	function fetchAgain(address: `0x${string}`, signer: Signer) {
		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}
		fetch(address, signer);
	}

	async function fetch(address: `0x${string}`, signer: Signer) {
		set({
			step: 'Fetching',
			domain: params.domain,
			address,
			signer
		});

		let registeredUser: CompleteUser | undefined;
		try {
			registeredUser = await getRegisteredUser(address);
		} catch (err) {
			set({
				step: 'Fetching',
				domain: params.domain,
				address,
				signer,
				error: { message: 'failed to fetch profile', cause: err }
			});

			// TODO ? or manual
			// setTimeout(fetchAgain, 1000);
			return;
		}
		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}
		if (registeredUser) {
			set({
				step: 'Registered',
				domain: params.domain,
				address,
				signer: signer,
				user: registeredUser,
				editing: false
			});
		} else {
			set({
				step: 'Unregistered',
				domain: params.domain,
				registering: false,
				address,
				signer
			});
		}
	}

	async function onAccountChanged() {
		const address = _account?.address;
		const signer = _account?.signer;

		if (address && signer) {
			await fetch(address, signer);
		} else {
			set({
				step: 'Idle',
				domain: params.domain
			});
		}
	}

	const { subscribe } = derived<Readable<Account>, MissivRegistration>(
		params.account,
		($account, set) => {
			_set = set;
			const changes =
				($account?.signer && !_account?.signer) ||
				(!$account?.signer && _account?.signer) ||
				$account?.signer?.address !== _account?.signer?.address;

			if (changes) {
				_account = $account;
				onAccountChanged();
			}
		},
		$missivRegistration
	);

	function set(missivRegistration: MissivRegistration) {
		$missivRegistration = missivRegistration;
		_set($missivRegistration);
		return $missivRegistration;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($missivRegistration) {
			set({
				...$missivRegistration,
				error
			});
		} else {
			throw new Error(`no missivRegistration`);
		}
	}

	async function register(
		signature: `0x${string}`, // TODO is that 0x
		options?: {
			name?: string;
			description?: string;
		}
	) {
		const address = _account?.address;
		const signer = _account?.signer;
		if (!(address && signer)) {
			throw new Error(`no account`);
		}

		set({
			step: 'Unregistered',
			domain: params.domain,
			registering: true,
			address,
			signer
		});

		try {
			await api.register(
				{
					type: 'register',
					address,
					domain: params.domain,
					appOrigin: requireAppOrigin(),
					signature,
					name: options?.name,
					description: options?.description
				},
				{
					privateKey: signer.privateKey
				}
			);
		} catch (err) {
			set({
				step: 'Unregistered',
				domain: params.domain,
				registering: false,
				address,
				signer,
				error: { message: `failed to register user` }
			});
			throw err;
		}

		let registeredUser: CompleteUser | undefined;
		try {
			registeredUser = await getRegisteredUser(address);
		} catch (err) {}

		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}

		if (registeredUser) {
			set({
				step: 'Registered',
				domain: params.domain,
				address: address,
				signer: signer,
				user: registeredUser,
				editing: false
			});
		} else {
			set({
				step: 'Unregistered',
				domain: params.domain,
				registering: false,
				address,
				signer,
				error: { message: `failed to get registered user` }
			});
			throw new Error(`fauled to get registered user`);
		}
	}

	async function edit(options: { name?: string; description?: string }) {
		const address = _account?.address;
		const signer = _account?.signer;
		if (!(address && signer)) {
			throw new Error(`no account`);
		}

		if ($missivRegistration.step !== 'Registered') {
			throw new Error(`not even registered`);
		}

		set({
			step: 'Registered',
			domain: params.domain,
			address: $missivRegistration.address,
			signer: $missivRegistration.signer,
			user: $missivRegistration.user,
			editing: true
		});
		await api.editUser(
			{
				type: 'editUser',
				domain: params.domain,
				name: options?.name,
				description: options?.description
			},
			{
				privateKey: signer.privateKey
			}
		);

		const registeredUser = await getRegisteredUser(address);

		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}

		if (registeredUser) {
			set({
				step: 'Registered',
				domain: params.domain,
				address: address,
				signer: signer,
				user: registeredUser,
				editing: false
			});
		} else {
			set({
				step: 'Registered',
				domain: params.domain,
				address,
				signer,
				editing: false,
				user: $missivRegistration.user,
				error: { message: `failed to get registered user` }
			});
			throw new Error(`fauled to get registered user`);
		}
	}

	function requireAppOrigin(): string {
		if (!appOrigin) {
			throw new Error(`no appOrigin: pass it to createMissivRegistration outside a browser`);
		}
		return appOrigin;
	}

	return {
		subscribe,
		/** the origin the publication signature must name */
		get appOrigin() {
			return requireAppOrigin();
		},
		register,
		edit,
		getRegisteredUser
	};
}

export type MissivRegistrationStore = ReturnType<typeof createMissivRegistration>;
