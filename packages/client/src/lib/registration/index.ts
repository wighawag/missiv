import { API } from '$lib/API.js';
import type { DomainUser, MissivUser } from 'missiv-common';
import { derived, type Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string; publicKey: string };
type AccountWithSigner = { address: string; signer: Signer };
export type Account = AccountWithSigner | { address: string; signer: undefined } | undefined;
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
			address: string;
			signer: Signer;
	  }
	| {
			// Account is Available, but not registered yet
			step: 'Unregistered';
			domain: string;
			registering: boolean; // can be registering
			address: string;
			signer: Signer;
	  }
	| {
			// Account is Available and registered
			step: 'Registered';
			domain: string;
			editing: boolean; // can be editing
			address: string;
			signer: Signer;
			user: CompleteUser;
	  }
);

export type CompleteUser = DomainUser & MissivUser;

export function createMissivRegistration(params: {
	endpoint: string;
	domain: string;
	account: Readable<Account>;
}) {
	const api: API = new API(params.endpoint);

	let $missivRegistration: MissivRegistration = {
		step: 'Idle',
		domain: params.domain
	};
	let _set: (value: MissivRegistration) => void;
	let _account: Account | undefined;

	async function getRegisteredUser(address: string): Promise<CompleteUser | undefined> {
		const { completeUser } = await api.getCompleteUser({
			address: address,
			domain: params.domain
		});
		return completeUser;
	}

	function fetchAgain(address: string, signer: Signer) {
		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}
		fetch(address, signer);
	}

	async function fetch(address: string, signer: Signer) {
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
		signature: string,
		options?: {
			name?: string;
			domainUsername?: string;
			domainDescription?: string;
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
					signature,
					domainUsername: options?.domainUsername,
					name: options?.name,
					domainDescription: options?.domainDescription,
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

	async function edit(options: {
		name?: string;
		domainUsername?: string;
		domainDescription?: string;
		description?: string;
	}) {
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
				domainUsername: options?.domainUsername,
				name: options?.name,
				domainDescription: options?.domainDescription,
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

	return {
		subscribe,
		register,
		edit
	};
}

export type MissivRegistrationStore = ReturnType<typeof createMissivRegistration>;
