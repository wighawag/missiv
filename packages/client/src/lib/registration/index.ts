import { API, type FetchFunction } from '$lib/API.js';
import type { DomainUser } from 'missiv-common';
import type { Readable } from 'svelte/store';
import { publicKeyOf, verifyDomainUser } from '$lib/messages.js';
import {
	activeStore,
	toStoreError,
	type RunContext,
	type StoreError
} from '$lib/utils/lifecycle.js';

type Signer = { address: `0x${string}`; privateKey: string; publicKey: string };
type AccountWithSigner = { address: `0x${string}`; signer: Signer };
export type Account = AccountWithSigner | { address: `0x${string}`; signer: undefined } | undefined;
export type AccountStore = Readable<Account>;

export type MissivRegistration = { error?: StoreError } & (
	| {
			// no account (or no signer) to fetch a registration for
			step: 'Idle';
			domain: string;
	  }
	| {
			// fetching the account's registration
			step: 'Fetching';
			domain: string;
			address: `0x${string}`;
			signer: Signer;
	  }
	| {
			// not registered in this domain yet (or registering)
			step: 'Unregistered';
			domain: string;
			registering: boolean;
			/**
			 * another key is registered for this account in this domain (another device,
			 * or a key the server cannot prove): registering this one replaces it, and the
			 * messages encrypted to the other become unreadable here
			 */
			otherKey?: boolean;
			address: `0x${string}`;
			signer: Signer;
	  }
	| {
			// registered: the server's record is this signer's key, proven by this wallet
			step: 'Registered';
			domain: string;
			editing: boolean;
			address: `0x${string}`;
			signer: Signer;
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
	 * the app's origin, which the wallet's publication signature names (its host is
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
	let current:
		| { address: `0x${string}`; signer: Signer; ctx: RunContext<MissivRegistration> }
		| undefined;

	async function getRegisteredUser(address: `0x${string}`): Promise<DomainUser | undefined> {
		const { domainUser } = await api.getDomainUser({ type: 'getDomainUser', address, domain });
		return domainUser;
	}

	/** The registration the server holds for this signer: Registered only for this key, proven by this wallet. */
	async function stateOf(address: `0x${string}`, signer: Signer): Promise<MissivRegistration> {
		const user = await getRegisteredUser(address);
		if (
			user &&
			user.publicKey === publicKeyOf(signer) &&
			(await verifyDomainUser(user, { address, domain }))
		) {
			return { step: 'Registered', domain, address, signer, user, editing: false };
		}
		return { step: 'Unregistered', domain, address, signer, registering: false, otherKey: !!user };
	}

	const store = activeStore<Account, MissivRegistration>({
		source: params.account,
		key: (account) => (account?.signer ? `${account.address}:${account.signer.address}` : ''),
		initial: { step: 'Idle', domain },
		run(account, ctx) {
			if (!account?.signer) {
				current = undefined;
				ctx.set({ step: 'Idle', domain });
				return;
			}
			const { address, signer } = account;
			const run = { address, signer, ctx };
			current = run;
			ctx.set({ step: 'Fetching', domain, address, signer });
			let retry: ReturnType<typeof setTimeout> | undefined;
			const load = async () => {
				try {
					const state = await stateOf(address, signer);
					ctx.set(state);
				} catch (err) {
					ctx.set({
						step: 'Fetching',
						domain,
						address,
						signer,
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
	 * Register this signer's key for the account, with the wallet's signature over
	 * its publication message for `appOrigin`. Replaces another key of the account
	 * in this domain. Rejects with the server's error, also set on the store.
	 */
	async function register(
		signature: `0x${string}`,
		options?: { name?: string; description?: string }
	) {
		const { address, signer, ctx } = requireRun();
		ctx.set({ step: 'Unregistered', domain, address, signer, registering: true });
		try {
			await api.register(
				{
					type: 'register',
					address,
					domain,
					appOrigin: requireAppOrigin(),
					signature,
					name: options?.name,
					description: options?.description
				},
				{ privateKey: signer.privateKey }
			);
			const state = await stateOf(address, signer);
			if (state.step !== 'Registered') {
				throw new Error(`the server does not hold this key after registering it`);
			}
			ctx.set(state);
		} catch (err) {
			ctx.set({
				step: 'Unregistered',
				domain,
				address,
				signer,
				registering: false,
				error: toStoreError('failed to register', err)
			});
			throw err;
		}
	}

	/** Edit the account's profile in this domain. Rejects with the server's error, also set on the store. */
	async function edit(options: { name?: string; description?: string }) {
		const { address, signer, ctx } = requireRun();
		const state = ctx.get();
		if (state.step !== 'Registered') {
			throw new Error(`not registered`);
		}
		ctx.set({ ...state, editing: true, error: undefined });
		try {
			await api.editUser(
				{ type: 'editUser', domain, name: options.name, description: options.description },
				{ privateKey: signer.privateKey }
			);
			ctx.set(await stateOf(address, signer));
		} catch (err) {
			ctx.set({ ...state, editing: false, error: toStoreError('failed to edit the profile', err) });
			throw err;
		}
	}

	return {
		subscribe: store.subscribe,
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
