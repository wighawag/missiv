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
import {
	conversationIDOf,
	type ConversationStatus,
	type Message,
	type MessageToSend,
	type ResponseSendMessage,
} from '@missiv/common';
import {createInProcessLiveInbox, createServer, migrate, type PushNotifier} from '@missiv/server';
import {serve} from '@hono/node-server';
import {createNodeWebSocket} from '@hono/node-ws';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import {API, composeIntroduction, composeMessage} from '@missiv/client';
import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha256';

export const DOMAIN = 'test.com';
export const APP_ORIGIN = 'https://test.com';
export const NAMESPACE = 'test';
export const SERVER_URL = 'http://localhost';
/** the SESSION_SECRET every harness runs with unless its env says otherwise */
export const SESSION_SECRET = 'test-session-secret';

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
 * Its send budget is raised (`RATE_LIMIT_SEND_BURST`), so a test that sends a
 * long history from one account is not rate limited; a test of the limits passes
 * its own. `getIP` is the caller's IP as a platform finds it (none by default,
 * and an unknown IP is not limited per IP).
 * Its live inbox is held in process as on Node.js (`liveInbox`); `listen()` serves
 * the same app on a loopback port (with `@hono/node-ws`, as the Node.js platform
 * does) for the tests that need a real WebSocket, the live channel's, and
 * answers its URL.
 */
export function createHarness(
	env: Record<string, string | undefined> = {},
	options?: {notifier?: PushNotifier; getIP?: () => string | undefined},
) {
	env = {SESSION_SECRET, RATE_LIMIT_SEND_BURST: '1000', ...env};
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
	const liveInbox = createInProcessLiveInbox();
	// node-ws routes an upgrade request through the app, which is built below
	let app: ReturnType<typeof createServer>;
	const nodeWebSocket = createNodeWebSocket({
		app: {request: (...args: Parameters<typeof app.request>) => app.request(...args)} as any,
	});
	app = createServer({
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
		getIP: options?.getIP,
		liveInbox,
		upgradeWebSocket: nodeWebSocket.upgradeWebSocket as any,
	});
	const api = new API(SERVER_URL, {fetch: app.request as any});

	let ready: Promise<unknown> | undefined;
	function setupDatabase() {
		// the schema, as a platform creates it at start
		ready ??= migrate(db);
		return ready;
	}

	let server: ReturnType<typeof serve> | undefined;
	let listening: Promise<string> | undefined;
	/** serve the app on a loopback port (once); its URL */
	function listen(): Promise<string> {
		listening ??= setupDatabase().then(
			() =>
				new Promise<string>((resolve) => {
					server = serve({fetch: app.fetch, port: 0, hostname: '127.0.0.1'}, (info) =>
						resolve(`http://127.0.0.1:${info.port}`),
					);
					nodeWebSocket.injectWebSocket(server);
				}),
		);
		return listening;
	}
	/** cut every open WebSocket, as a lost network would (no close frame); the server goes on */
	function dropSockets() {
		for (const client of nodeWebSocket.wss.clients) {
			client.terminate();
		}
	}
	/** stop serving: every socket closed, the port released */
	async function close() {
		if (!server) {
			return;
		}
		for (const client of nodeWebSocket.wss.clients) {
			client.terminate();
		}
		await new Promise((resolve) => server!.close(resolve));
		server = undefined;
		listening = undefined;
	}

	return {
		app,
		api,
		db,
		env,
		queries,
		liveInbox,
		listen,
		dropSockets,
		close,
		setupDatabase,
		...createActions(api, {before: setupDatabase}),
	};
}

export type Actions = ReturnType<typeof createActions>;

/**
 * The actions over real HTTP to a server at `url` (or through `fetch`): for a
 * platform's own tests and the load harness, which have no @missiv/client of
 * their own to build an `API` with.
 */
export function createRemoteActions(url: string, options?: {fetch?: typeof fetch}) {
	const api = new API(url, options?.fetch ? {fetch: options.fetch} : undefined);
	return {api, ...createActions(api)};
}

/**
 * The actions a test (or the load harness, `test/load`) takes as its users, over
 * any @missiv/client `API`: in process (`app.request`) or over real HTTP. A
 * registration is signed by the acting user's signing key; a message is
 * composed and signed as @missiv/client composes it (`composeMessage`,
 * `composeIntroduction`); everything else is on the user's session.
 */
export function createActions(api: API, options?: {before?: () => Promise<unknown>}) {
	const before = options?.before ?? (() => Promise.resolve());
	const as = (user: TestUser) => ({privateKey: user.keySet.signing.privateKey});

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
			as(user),
		);
	}

	async function registerAll(users: TestUser[]) {
		for (const user of users) {
			await register(user);
		}
	}

	/** A message from `from` to `to`, composed and signed as the client does: an introduction (`clear`) by default. */
	function compose({
		from,
		to,
		content = 'Test message',
		scheme = 'clear',
		domain = DOMAIN,
		namespace = NAMESPACE,
		messageID,
	}: {
		from: TestUser;
		to: TestUser;
		content?: string;
		scheme?: 'clear' | 'pairwise-v1';
		domain?: string;
		namespace?: string;
		messageID?: string;
	}): Promise<MessageToSend> {
		const params = {
			destination: {domain, namespace},
			sender: {address: from.address, keySet: from.keySet},
			text: content,
			messageID,
		};
		return scheme === 'pairwise-v1'
			? composeMessage({...params, recipient: {address: to.address, keySet: publicOf(to.keySet)}})
			: composeIntroduction({...params, recipient: {address: to.address}});
	}

	/** Send a message as `from` (on `from`'s session); a composed one, or `compose`'s. */
	async function sendMessage(from: TestUser, message: MessageToSend): Promise<ResponseSendMessage> {
		return api.sendMessage({type: 'sendMessage', message}, as(from));
	}

	async function send(params: Parameters<typeof compose>[0]): Promise<ResponseSendMessage & {message: MessageToSend}> {
		const message = await compose(params);
		return {...(await sendMessage(params.from, message)), message};
	}

	const scope = (conversationID: string, where?: {domain?: string; namespace?: string}) => ({
		domain: where?.domain ?? DOMAIN,
		namespace: where?.namespace ?? NAMESPACE,
		conversationID,
	});

	async function accept(user: TestUser, conversationID: string, where?: {domain?: string; namespace?: string}) {
		await api.accept({type: 'accept', ...scope(conversationID, where)}, as(user));
	}

	async function reject(user: TestUser, conversationID: string, where?: {domain?: string; namespace?: string}) {
		await api.reject({type: 'reject', ...scope(conversationID, where)}, as(user));
	}

	async function markRead(
		user: TestUser,
		conversationID: string,
		seq: number,
		where?: {domain?: string; namespace?: string},
	) {
		await api.markRead({type: 'markRead', ...scope(conversationID, where), seq}, as(user));
	}

	/** Share (or stop sharing) `user`'s read receipts in the domain. */
	async function shareReadReceipts(user: TestUser, readReceipts: boolean, domain = DOMAIN) {
		return (await api.setSettings({type: 'setSettings', domain, readReceipts}, as(user))).settings;
	}

	/** The messages `user` lists, in seq order: the newest page, or a page `after` / `before` a seq. */
	async function messages(
		user: TestUser,
		conversationID: string,
		page?: {domain?: string; namespace?: string; after?: number; before?: number; limit?: number},
	): Promise<Message[]> {
		const {domain, namespace, ...cursor} = page ?? {};
		const result = await api.listMessages(
			{type: 'listMessages', ...scope(conversationID, {domain, namespace}), ...cursor},
			as(user),
		);
		return result.messages;
	}

	async function contents(user: TestUser, conversationID: string, where?: {domain?: string; namespace?: string}) {
		return (await messages(user, conversationID, where)).map((m) => m.content);
	}

	async function conversations(
		user: TestUser,
		status?: ConversationStatus,
		where?: {domain?: string; namespace?: string},
	) {
		return (
			await api.listConversations(
				{
					type: 'listConversations',
					domain: where?.domain ?? DOMAIN,
					namespace: where?.namespace ?? NAMESPACE,
					...(status ? {status} : {}),
				},
				as(user),
			)
		).conversations;
	}

	return {
		register,
		registerAll,
		compose,
		sendMessage,
		send,
		accept,
		reject,
		markRead,
		shareReadReceipts,
		messages,
		contents,
		conversations,
		accepted: (user: TestUser, where?: {domain?: string; namespace?: string}) => conversations(user, 'accepted', where),
		unaccepted: (user: TestUser, where?: {domain?: string; namespace?: string}) =>
			conversations(user, 'unaccepted', where),
	};
}
