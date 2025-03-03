import { API } from '$lib/API.js';
import type { DomainUser, MissivUser } from 'missiv-common';
import { derived, type Readable } from 'svelte/store';

type Signer = { address: string; privateKey: string; publicKey: string };
type AccountWithSigner = { address: string; signer: Signer };
export type Account = AccountWithSigner | { address: string; signer: undefined } | undefined;

export type MissivAccount = { error?: { message: string; cause?: any } } & (
	| {
			settled: false;
			registered: false;
			registering: false;
			loading: false;
	  }
	| {
			settled: false;
			registered: false;
			registering: false;
			loading: true;
			address: string;
			signer: Signer;
	  }
	| {
			settled: true;
			registered: false;
			registering: false;
			address: string;
			signer: Signer;
	  }
	| {
			settled: true;
			registered: false;
			registering: true;
			address: string;
			signer: Signer;
	  }
	| {
			settled: true;
			registered: true;
			registering: false;
			address: string;
			signer: Signer;
			user: CompleteUser;
			editing: boolean;
	  }
);

export type CompleteUser = DomainUser & MissivUser;

export function createMissivAccount(params: {
	endpoint: string;
	domain: string;
	account: Readable<Account>;
}) {
	const api: API = new API(params.endpoint);

	let $missivAccount: MissivAccount = {
		settled: false,
		registered: false,
		registering: false,
		loading: false
	};
	let _set: (value: MissivAccount) => void;
	let _account: Account | undefined;

	async function getRegisteredUser(address: string): Promise<CompleteUser | undefined> {
		const { completeUser } = await api.getCompleteUser({
			address: address,
			domain: params.domain
		});
		return completeUser;
	}

	async function onAccountChanged() {
		const address = _account?.address;
		const signer = _account?.signer;

		if (address && signer) {
			set({
				settled: false,
				loading: true,
				registered: false,
				registering: false,
				address,
				signer
			});
			const registeredUser = await getRegisteredUser(address);
			if (address !== _account?.address) {
				// account change in between, ignore
				return;
			}
			if (registeredUser) {
				set({
					settled: true,
					registered: true,
					registering: false,
					address,
					signer: _account.signer,
					user: registeredUser,
					editing: false
				});
			} else {
				set({
					settled: true,
					registered: false,
					registering: false,
					address,
					signer
				});
			}
		} else {
			set({
				settled: false,
				loading: false,
				registered: false,
				registering: false
			});
		}
	}

	const { subscribe } = derived<Readable<Account>, MissivAccount>(
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
		$missivAccount
	);

	function set(missivAccount: MissivAccount) {
		$missivAccount = missivAccount;
		_set($missivAccount);
		return $missivAccount;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($missivAccount) {
			set({
				...$missivAccount,
				error
			});
		} else {
			throw new Error(`no missivAccount`);
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
			settled: true,
			registered: false,
			registering: true,
			address,
			signer
		});

		// TODO try catch
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

		const registeredUser = await getRegisteredUser(address);

		if (address !== _account?.address) {
			// account change in between, ignore
			return;
		}

		if (registeredUser) {
			set({
				settled: true,
				registering: false,
				registered: true,
				address: address,
				signer: signer,
				user: registeredUser,
				editing: false
			});
		} else {
			set({
				settled: true,
				registering: false,
				registered: false,
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

		if (!$missivAccount.registered) {
			throw new Error(`not even registered`);
		}

		set({
			settled: true,
			registered: true,
			registering: false,
			address: $missivAccount.address,
			signer: $missivAccount.signer,
			user: $missivAccount.user,
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
				settled: true,
				registering: false,
				registered: true,
				address: address,
				signer: signer,
				user: registeredUser,
				editing: false
			});
		} else {
			set({
				settled: true,
				registering: false,
				registered: true,
				address,
				signer,
				editing: false,
				user: $missivAccount.user,
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

export type MissivAccountStore = ReturnType<typeof createMissivAccount>;
