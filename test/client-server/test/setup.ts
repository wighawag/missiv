// The client-server harness: a missiv server in process (Hono's app.request on
// in-memory libSQL, no port), driven through @missiv/client's API with REAL keys,
// as @etherplay/connect makes them: each user is a wallet and an origin key, from
// which delegated-identity derives the user's key set (an Ed25519 signing key, an
// X25519 encryption key); the wallet signs the ownership proof of the key set,
// and its signing key signs every request. The server runs with no DEV flag, as
// in production; a test that needs another configuration passes its own env.
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {
	deriveKeySet,
	keySetRef,
	originPublicKeyPublicationMessage,
	type KeySet,
	type PublicKeySet,
} from 'delegated-identity';
import {conversationIDOf, signMessageCopy, type ConversationMessage} from '@missiv/common';
import {createServer, migrate, type PushNotifier} from '@missiv/server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import {API} from '@missiv/client';
import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha256';

export const DOMAIN = 'test.com';
export const APP_ORIGIN = 'https://test.com';
export const NAMESPACE = 'test';
export const SERVER_URL = 'http://localhost';
/** the SESSION_SECRET every harness runs with unless its env says otherwise */
export const SESSION_SECRET = 'test-session-secret';
/** a well-formed copy signature: the server stores a copy's signature and never checks it (its reader does) */
export const UNCHECKED_SIGNATURE = `0x${'11'.repeat(64)}` as `0x${string}`;

export type TestUser = {
	address: `0x${string}`;
	/** the origin private key the key set is derived from (connect's origin key for APP_ORIGIN) */
	originPrivateKey: `0x${string}`;
	/** the user's key set in the app, private halves included */
	keySet: KeySet;
	/** `keySetRef` of the key set */
	keyRef: `0x${string}`;
	/** the wallet's signature over the publication message of the key set, for APP_ORIGIN */
	ownershipSignature: `0x${string}`;
	/** sign the publication message of a key set (another one, or for another origin) */
	signPublication(keySet: PublicKeySet, origin?: string): Promise<`0x${string}`>;
};

/** The public half of a key set, as it is registered. */
export function publicOf(keySet: PublicKeySet): PublicKeySet {
	return {signing: {publicKey: keySet.signing.publicKey}, encryption: {publicKey: keySet.encryption.publicKey}};
}

export async function createUser(): Promise<TestUser> {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const originPrivateKey = generatePrivateKey();
	const keySet = deriveKeySet(originPrivateKey);
	const signPublication = async (keySet: PublicKeySet, origin: string = APP_ORIGIN) =>
		(
			await wallet.signMessage({message: originPublicKeyPublicationMessage(origin, keySet)})
		).toLowerCase() as `0x${string}`;
	return {
		address: wallet.address.toLowerCase() as `0x${string}`,
		originPrivateKey,
		keySet,
		keyRef: await keySetRef(keySet),
		ownershipSignature: await signPublication(keySet),
		signPublication,
	};
}

/** A @missiv/client account of a test user, as connect's signed-in account carries it. */
export function accountOf(user: TestUser, keySet: KeySet = user.keySet) {
	return {
		address: user.address,
		keySet,
		savedPublicKeyPublicationSignature: keySet === user.keySet ? user.ownershipSignature : undefined,
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

/** Another key set (from another origin key): what a wallet derives for another app, or an attacker's. */
export function newKeySet(): KeySet {
	return deriveKeySet(generatePrivateKey());
}

export {conversationIDOf};

export type Harness = ReturnType<typeof createHarness>;

/** The claims of a session token (ADR-0006): the account, its domain, its key set and the expiry (ms). */
export type SessionClaims = {account: string; domain: string; keyRef: string; exp: number};

/**
 * A session token minted here, independently of the server, from ADR-0006's
 * format: base64url of the claims' JSON, a dot, base64url of the HMAC-SHA256 of
 * that first part under the secret. A token the server accepts from this is one
 * a holder of the secret could forge, and nobody else.
 */
export function mintSessionToken(secret: string, claims: SessionClaims): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const mac = Buffer.from(hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(payload))).toString(
		'base64url',
	);
	return `${payload}.${mac}`;
}

/**
 * The in-process server, its SESSION_SECRET set (pass `SESSION_SECRET: undefined`
 * for a server without), and `queries`: every SQL statement it prepared, in order.
 */
export function createHarness(env: Record<string, string | undefined> = {}, options?: {notifier?: PushNotifier}) {
	env = {SESSION_SECRET, ...env};
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	const queries: string[] = [];
	// the database as the server sees it, recording each statement it prepares
	const recorded = new Proxy(db, {
		get(target, property) {
			if (property === 'prepare') {
				return (sql: string) => {
					queries.push(sql);
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const app = createServer({
		services: {
			getDB() {
				return recorded;
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

	return {app, api, db, env, queries, setupDatabase, ...createActions(api, {before: setupDatabase})};
}

export type Actions = ReturnType<typeof createActions>;

/**
 * The actions a test (or the load harness, `test/load`) takes as its users, over
 * any @missiv/client `API`: in process (`app.request`) or over real HTTP. Each
 * request is signed by the acting user's signing key, each copy by the sender's.
 */
export function createActions(api: API, options?: {before?: () => Promise<unknown>}) {
	const before = options?.before ?? (() => Promise.resolve());

	async function register(user: TestUser, options?: {domain?: string; name?: string}) {
		await before();
		return api.register(
			{
				type: 'register',
				address: user.address,
				keySet: publicOf(user.keySet),
				ownershipSignature: user.ownershipSignature,
				domain: options?.domain || DOMAIN,
				appOrigin: APP_ORIGIN,
				name: options?.name,
			},
			{privateKey: user.keySet.signing.privateKey},
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
				toPublicKey: recipient.keySet.encryption.publicKey,
				// each copy signed by the sender, as @missiv/client signs it
				signature: await signMessageCopy(
					{
						domain,
						namespace: NAMESPACE,
						conversationID: id,
						messageType,
						from: from.address,
						to: recipient.address,
						toPublicKey: messageType === 'encrypted' ? recipient.keySet.encryption.publicKey : undefined,
						content,
					},
					from.keySet.signing.privateKey,
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
			{privateKey: from.keySet.signing.privateKey},
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
			{privateKey: user.keySet.signing.privateKey},
		);
	}

	async function reject(user: TestUser, conversationID: string) {
		await api.rejectConversation(
			{type: 'rejectConversation', domain: DOMAIN, namespace: NAMESPACE, conversationID},
			{privateKey: user.keySet.signing.privateKey},
		);
	}

	async function messages(user: TestUser, conversationID: string, domain = DOMAIN): Promise<ConversationMessage[]> {
		const result = await api.getMessages(
			{type: 'getMessages', domain, namespace: NAMESPACE, conversationID},
			{privateKey: user.keySet.signing.privateKey},
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
				{privateKey: user.keySet.signing.privateKey},
			)
		).acceptedConversations;
	}

	async function unaccepted(user: TestUser) {
		return (
			await api.getUnacceptedConversations(
				{type: 'getUnacceptedConversations', domain: DOMAIN, namespace: NAMESPACE},
				{privateKey: user.keySet.signing.privateKey},
			)
		).unacceptedConversations;
	}

	return {
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
