// The client-server harness: a missiv server in process (Hono's app.request on
// in-memory libSQL, no port), driven through missiv-client's API with REAL keys:
// each user is a wallet that signs the ownership proof of a delegate key, and the
// delegate key signs every request. The server runs with no DEV flag, as in
// production; a test that needs another configuration passes its own env.
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {getPublicKey, utils as secpUtils} from '@noble/secp256k1';
import {
	conversationIDOf,
	originPublicKeyPublicationMessage,
	signMessageCopy,
	type ConversationMessage,
} from 'missiv-common';
import {createServer, migrate, type PushNotifier} from 'missiv-server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import {API} from 'missiv-client';

export const DOMAIN = 'test.com';
export const APP_ORIGIN = 'https://test.com';
export const NAMESPACE = 'test';
export const SERVER_URL = 'http://localhost';
/** a well-formed copy signature: the server stores a copy's signature and never checks it (its reader does) */
export const UNCHECKED_SIGNATURE = `0x${'11'.repeat(64)}00` as `0x${string}`;

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

export type TestUser = {
	address: `0x${string}`;
	delegatePrivateKey: Uint8Array;
	delegatePublicKey: `0x${string}`;
	/** the wallet's signature over the publication message of the delegate key, for APP_ORIGIN */
	ownershipSignature: `0x${string}`;
	/** sign the publication message of another delegate key (a second device), for an origin */
	signPublication(publicKey: `0x${string}`, origin?: string): Promise<`0x${string}`>;
};

export async function createUser(): Promise<TestUser> {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const delegatePrivateKey = secpUtils.randomPrivateKey();
	const delegatePublicKey = toHex(getPublicKey(delegatePrivateKey));
	const signPublication = async (publicKey: `0x${string}`, origin: string = APP_ORIGIN) =>
		(
			await wallet.signMessage({message: originPublicKeyPublicationMessage(origin, publicKey)})
		).toLowerCase() as `0x${string}`;
	return {
		address: wallet.address.toLowerCase() as `0x${string}`,
		delegatePrivateKey,
		delegatePublicKey,
		ownershipSignature: await signPublication(delegatePublicKey),
		signPublication,
	};
}

/** A missiv-client account of a test user: its wallet address and its delegate key as the signer. */
export function accountOf(user: TestUser) {
	return {
		address: user.address,
		signer: {
			address: user.address,
			privateKey: toHex(user.delegatePrivateKey),
			publicKey: user.delegatePublicKey,
		},
	};
}

/** The first value of a store that matches, or a timeout. */
export function until<T>(
	store: {subscribe(run: (value: T) => void): () => void},
	predicate: (value: T) => boolean,
	timeoutMs = 2000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let unsubscribe: (() => void) | undefined;
		let done = false;
		const timer = setTimeout(() => {
			done = true;
			unsubscribe?.();
			reject(new Error(`no matching value within ${timeoutMs} ms`));
		}, timeoutMs);
		unsubscribe = store.subscribe((value) => {
			if (!done && predicate(value)) {
				done = true;
				clearTimeout(timer);
				queueMicrotask(() => unsubscribe?.());
				resolve(value);
			}
		});
		if (done) {
			unsubscribe();
		}
	});
}

export function newDelegateKey() {
	const privateKey = secpUtils.randomPrivateKey();
	return {privateKey, publicKey: toHex(getPublicKey(privateKey))};
}

export {conversationIDOf};

export type Harness = ReturnType<typeof createHarness>;

export function createHarness(env: Record<string, string | undefined> = {}, options?: {notifier?: PushNotifier}) {
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	const app = createServer({
		services: {
			getDB() {
				return db;
			},
			getRoom() {
				throw new Error(`no getRoom implemented in test`);
			},
			getRateLimiter() {
				throw new Error(`no getRateLimiter implemented in test`);
			},
		},
		getEnv() {
			return env as any;
		},
		getPushNotifier: options?.notifier ? () => options.notifier : undefined,
		upgradeWebSocket() {
			return (() => {}) as any;
		},
	});
	const api = new API(SERVER_URL, {fetch: app.request as any});

	let ready: Promise<unknown> | undefined;
	function setupDatabase() {
		// the schema, as a platform creates it at start
		ready ??= migrate(db);
		return ready;
	}

	async function register(user: TestUser, options?: {domain?: string; name?: string}) {
		await setupDatabase();
		return api.register(
			{
				type: 'register',
				address: user.address,
				signature: user.ownershipSignature,
				domain: options?.domain || DOMAIN,
				appOrigin: APP_ORIGIN,
				name: options?.name,
			},
			{privateKey: user.delegatePrivateKey},
		);
	}

	async function registerAll(users: TestUser[]) {
		for (const user of users) {
			await register(user);
		}
	}

	async function send({
		from,
		to,
		content = 'Test message',
		conversationID,
		messageType = 'clear',
		timestamp = Date.now(),
		domain = DOMAIN,
	}: {
		from: TestUser;
		to: TestUser | TestUser[];
		content?: string;
		conversationID?: string;
		messageType?: 'clear' | 'encrypted';
		timestamp?: number;
		domain?: string;
	}) {
		const recipients = Array.isArray(to) ? to : [to];
		const all = recipients.some((r) => r.address === from.address) ? recipients : [from, ...recipients];
		const id = conversationID || conversationIDOf(all.map((v) => v.address));
		const messages = await Promise.all(
			all.map(async (recipient) => ({
				content,
				to: recipient.address,
				toPublicKey: recipient.delegatePublicKey,
				// each copy signed by the sender, as missiv-client signs it
				signature: await signMessageCopy(
					{
						domain,
						namespace: NAMESPACE,
						conversationID: id,
						messageType,
						from: from.address,
						to: recipient.address,
						toPublicKey: messageType === 'encrypted' ? recipient.delegatePublicKey : undefined,
						content,
					},
					from.delegatePrivateKey,
				),
			})),
		);
		return api.sendMessage(
			{
				type: 'sendMessage',
				domain,
				namespace: NAMESPACE,
				messages,
				messageType,
				conversationID: id,
				lastMessageReadTimestampMS: timestamp,
			},
			{privateKey: from.delegatePrivateKey},
		);
	}

	async function accept(user: TestUser, conversationID: string, timestamp = Date.now()) {
		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: DOMAIN,
				namespace: NAMESPACE,
				conversationID,
				lastMessageReadTimestampMS: timestamp,
			},
			{privateKey: user.delegatePrivateKey},
		);
	}

	async function reject(user: TestUser, conversationID: string) {
		await api.rejectConversation(
			{type: 'rejectConversation', domain: DOMAIN, namespace: NAMESPACE, conversationID},
			{privateKey: user.delegatePrivateKey},
		);
	}

	async function messages(user: TestUser, conversationID: string, domain = DOMAIN): Promise<ConversationMessage[]> {
		const result = await api.getMessages(
			{type: 'getMessages', domain, namespace: NAMESPACE, conversationID},
			{privateKey: user.delegatePrivateKey},
		);
		return result.messages;
	}

	async function contents(user: TestUser, conversationID: string) {
		return (await messages(user, conversationID)).map((m) => m.content);
	}

	async function accepted(user: TestUser) {
		return (
			await api.getAcceptedConversations(
				{type: 'getAcceptedConversations', domain: DOMAIN, namespace: NAMESPACE},
				{privateKey: user.delegatePrivateKey},
			)
		).acceptedConversations;
	}

	async function unaccepted(user: TestUser) {
		return (
			await api.getUnacceptedConversations(
				{type: 'getUnacceptedConversations', domain: DOMAIN, namespace: NAMESPACE},
				{privateKey: user.delegatePrivateKey},
			)
		).unacceptedConversations;
	}

	return {
		app,
		api,
		db,
		env,
		setupDatabase,
		register,
		registerAll,
		send,
		accept,
		reject,
		messages,
		contents,
		accepted,
		unaccepted,
	};
}
