import { API, type FetchFunction } from '$lib/API.js';
import type { DomainUser, KeySet } from '@missiv/common';
import type { Readable } from 'svelte/store';
import { publicKeySetOf, sameKeySet, verifyDomainUser } from '$lib/messages.js';
import {
	activeStore,
	toStoreError,
	type RunContext,
	type StoreError
} from '$lib/utils/lifecycle.js';

/**
 * The account the stores act for, as `@etherplay/connect`'s signed-in account
 * carries it (its `OriginAccount` is one): the wallet's address, its key set in
 * this app (delegated-identity's, private halves included: the signing key signs
 * every request and message, the encryption key decrypts) and, once the wallet
 * signed it, the ownership signature of that key set for the app origin.
 * Undefined while no account is signed in.
 */
export type MissivAccount = {
	address: `0x${string}`;
	keySet: KeySet;
	/** the wallet's signature over the publication message of `keySet` for the app origin, when it has signed it */
	savedPublicKeyPublicationSignature?: `0x${string}`;
};
export type Account = MissivAccount | undefined;
export type AccountStore = Readable<Account>;

export type MissivRegistration = { error?: StoreError } & (
	| {
			// no account to fetch a registration for
			step: 'Idle';
			domain: string;
	  }
	| {
			// fetching the account's registration
			step: 'Fetching';
			domain: string;
			address: `0x${string}`;
			keySet: KeySet;
	  }
	| {
			// not registered in this domain yet (or registering)
			step: 'Unregistered';
			domain: string;
			registering: boolean;
			/**
			 * another key set is registered for this account in this domain (one this
			 * account's wallet no longer derives here, or one the server cannot prove):
			 * registering this one replaces it, and the messages encrypted to the other
			 * become unreadable here
			 */
			otherKey?: boolean;
			address: `0x${string}`;
			keySet: KeySet;
	  }
	| {
			// registered: the server's current key set is this account's, proven by this wallet
			step: 'Registered';
			domain: string;
			editing: boolean;
			address: `0x${string}`;
			keySet: KeySet;
			user: DomainUser;
	  }
);

/** @deprecated the domain user is the whole user now: use `DomainUser` */
export type CompleteUser = DomainUser;

const RETRY_MS = 5000;

export function createMissivRegistration(params: {
	endpoint: string;
	domain: string;
	/**
	 * the app's origin, which the wallet's ownership signature names (its host is
	 * `domain`); defaults to the page's origin in a browser
	 */
	appOrigin?: string;
	account: Readable<Account>;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
}) {
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);
	const domain = params.domain;
	const appOrigin =
		params.appOrigin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);

	/** the run of the current account, while subscribed */
	let current: { account: MissivAccount; ctx: RunContext<MissivRegistration> } | undefined;

	async function getRegisteredUser(address: `0x${string}`): Promise<DomainUser | undefined> {
		const { domainUser } = await api.getDomainUser({ type: 'getDomainUser', address, domain });
		return domainUser;
	}

	/** The registration the server holds for this account: Registered only for its key set, proven by its wallet. */
	async function stateOf(address: `0x${string}`, keySet: KeySet): Promise<MissivRegistration> {
		const user = await getRegisteredUser(address);
		if (
			user &&
			sameKeySet(user.keySet, keySet) &&
			(await verifyDomainUser(user, { address, domain }))
		) {
			return { step: 'Registered', domain, address, keySet, user, editing: false };
		}
		return { step: 'Unregistered', domain, address, keySet, registering: false, otherKey: !!user };
	}

	const store = activeStore<Account, MissivRegistration>({
		source: params.account,
		key: (account) =>
			account?.keySet
				? `${account.address}:${account.keySet.signing.publicKey}:${account.keySet.encryption.publicKey}`
				: '',
		initial: { step: 'Idle', domain },
		run(account, ctx) {
			if (!account?.keySet) {
				current = undefined;
				ctx.set({ step: 'Idle', domain });
				return;
			}
			const { address, keySet } = account;
			const run = { account, ctx };
			current = run;
			ctx.set({ step: 'Fetching', domain, address, keySet });
			let retry: ReturnType<typeof setTimeout> | undefined;
			const load = async () => {
				try {
					const state = await stateOf(address, keySet);
					ctx.set(state);
				} catch (err) {
					ctx.set({
						step: 'Fetching',
						domain,
						address,
						keySet,
						error: toStoreError('failed to fetch the registration', err)
					});
					if (ctx.active) retry = setTimeout(load, RETRY_MS);
				}
			};
			load();
			return () => {
				if (retry) clearTimeout(retry);
				if (current === run) current = undefined;
			};
		}
	});

	function requireRun() {
		if (!current) {
			throw new Error(`no account (or the registration store has no subscriber)`);
		}
		return current;
	}

	function requireAppOrigin(): string {
		if (!appOrigin) {
			throw new Error(`no appOrigin: pass it to createMissivRegistration outside a browser`);
		}
		return appOrigin;
	}

	/**
	 * Register the account's key set, with the wallet's ownership signature over
	 * its publication message for `appOrigin`: `ownershipSignature`, or else the
	 * account's `savedPublicKeyPublicationSignature`. Every device of the account
	 * derives the same key set, so registering it again keeps it; another key set
	 * of the account in this domain is replaced. Rejects with the server's error,
	 * also set on the store.
	 */
	async function register(
		ownershipSignature?: `0x${string}`,
		options?: { name?: string; description?: string }
	) {
		const { account, ctx } = requireRun();
		const { address, keySet } = account;
		ctx.set({ step: 'Unregistered', domain, address, keySet, registering: true });
		try {
			const signature = ownershipSignature ?? account.savedPublicKeyPublicationSignature;
			if (!signature) {
				throw new Error(`no ownership signature: the wallet has not signed this key set`);
			}
			await api.register(
				{
					type: 'register',
					address,
					domain,
					appOrigin: requireAppOrigin(),
					keySet: publicKeySetOf(keySet),
					ownershipSignature: signature,
					name: options?.name,
					description: options?.description
				},
				{ privateKey: keySet.signing.privateKey }
			);
			const state = await stateOf(address, keySet);
			if (state.step !== 'Registered') {
				throw new Error(`the server does not hold this key set after registering it`);
			}
			ctx.set(state);
		} catch (err) {
			ctx.set({
				step: 'Unregistered',
				domain,
				address,
				keySet,
				registering: false,
				error: toStoreError('failed to register', err)
			});
			throw err;
		}
	}

	/** Edit the account's profile in this domain. Rejects with the server's error, also set on the store. */
	async function edit(options: { name?: string; description?: string }) {
		const { account, ctx } = requireRun();
		const { address, keySet } = account;
		const state = ctx.get();
		if (state.step !== 'Registered') {
			throw new Error(`not registered`);
		}
		ctx.set({ ...state, editing: true, error: undefined });
		try {
			await api.editUser(
				{ type: 'editUser', domain, name: options.name, description: options.description },
				{ privateKey: keySet.signing.privateKey }
			);
			ctx.set(await stateOf(address, keySet));
		} catch (err) {
			ctx.set({ ...state, editing: false, error: toStoreError('failed to edit the profile', err) });
			throw err;
		}
	}

	return {
		subscribe: store.subscribe,
		/** the origin the ownership signature must name */
		get appOrigin() {
			return requireAppOrigin();
		},
		register,
		edit,
		getRegisteredUser
	};
}

export type MissivRegistrationStore = ReturnType<typeof createMissivRegistration>;
