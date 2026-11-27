import {Hono} from 'hono';
import type {WSEvents} from 'hono/ws';
import {
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	HEARTBEAT_TIMEOUT_REASON,
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_SESSION_EXPIRED_REASON,
	INBOX_WS_PROTOCOL,
	InboxSyncSchema,
	MAX_PAGE_SIZE,
	membersOfConversationID,
	parseInboxConversationKey,
	type InboxServerFrame,
	type InboxSync,
	type Message,
} from '@missiv/common';
import type {ServerOptions} from '../../types.js';
import type {Env} from '../../env.js';
import {sessionSecrets, setup} from '../../setup.js';
import {MissivError} from '../../errors.js';
import {verifySessionToken, type SessionClaims} from '../../session.js';
import {watchIdle, type IdleWatch} from '../../heartbeat.js';
import type {ConversationStore, Inbox, LiveConnection, LiveInboxHost, LiveInboxRouter} from '../../stores/ports.js';

/** What answering a `sync` needs of the stores: a conversation's messages, and the account's inbox rows. */
export type SyncStores = {
	conversations: Pick<ConversationStore, 'listMessages'>;
	inbox: Pick<Inbox, 'getConversation' | 'update'>;
};

/** The session token a client offers as its second WebSocket protocol, after `missiv-inbox`. */
function offeredToken(header: string | undefined): string | undefined {
	const offered = (header ?? '')
		.split(',')
		.map((protocol) => protocol.trim())
		.filter((protocol) => protocol.length > 0);
	if (!offered.includes(INBOX_WS_PROTOCOL)) {
		return undefined;
	}
	return offered.find((protocol) => protocol !== INBOX_WS_PROTOCOL);
}

/**
 * Answer a `sync`, conversation by conversation: every message after the
 * client's seq that the account can see, in seq order and page by page (so a
 * long absence costs memory of one page), then the account's inbox row; a
 * conversation it is not a member of (or a malformed key) is skipped, as it
 * would be refused over HTTP. Then `ready`.
 *
 * A sync also heals the row: when the newest message it sent is above the
 * row's `lastSeq` (or there is no row), the inbox update that message should
 * have made is applied first (`Inbox.update`, idempotent and monotonic), so a
 * row whose update is still being retried (Cloudflare's Inbox objects, updated
 * after the append and retried by alarm) is right as soon as the client syncs.
 * Where rows are written with the message (SQL), it never applies.
 */
export async function answerSync(
	stores: SyncStores,
	claims: SessionClaims,
	sync: InboxSync,
	send: (frame: InboxServerFrame) => void,
	isOpen: () => boolean,
): Promise<void> {
	for (const [key, since] of Object.entries(sync.since)) {
		const parsed = parseInboxConversationKey(key);
		const members = parsed && membersOfConversationID(parsed.conversationID);
		if (!parsed || !members || !members.includes(claims.account)) {
			continue;
		}
		const conversation = {domain: claims.domain, ...parsed};
		let after = since;
		let newest: Message | undefined;
		for (;;) {
			if (!isOpen()) {
				return;
			}
			const page = await stores.conversations.listMessages(claims.account, conversation, {
				after,
				limit: MAX_PAGE_SIZE,
			});
			for (const message of page.messages) {
				send({type: 'message', message});
				after = message.seq;
				newest = message;
			}
			if (!page.hasMore || page.messages.length === 0) {
				break;
			}
		}
		let row = await stores.inbox.getConversation(claims.account, conversation);
		if (newest && (!row || newest.seq > row.lastSeq)) {
			await stores.inbox.update({
				...conversation,
				user: claims.account,
				seq: newest.seq,
				lastMessageAt: newest.serverTimestamp,
				own: newest.sender === claims.account,
			});
			row = await stores.inbox.getConversation(claims.account, conversation);
		}
		if (row) {
			send({type: 'conversation', conversation: row});
		}
	}
	if (isOpen()) {
		send({type: 'ready'});
	}
}

/**
 * The claims of the session token an inbox upgrade offers (`Sec-WebSocket-Protocol:
 * missiv-inbox, <token>`), checked BEFORE any socket is accepted: an absent,
 * invalid or expired one throws 401 (`unauthenticated`), as every other route
 * refuses it.
 */
export function checkInboxUpgrade(protocolHeader: string | undefined, secrets: string[], now: number): SessionClaims {
	const token = offeredToken(protocolHeader);
	if (!token) {
		throw new MissivError(
			'unauthenticated',
			`a session token is required, offered as the WebSocket protocol after ${INBOX_WS_PROTOCOL}`,
		);
	}
	const checked = verifySessionToken(token, secrets, now);
	if (!checked.ok) {
		throw new MissivError(
			'unauthenticated',
			checked.reason === 'expired' ? 'the session token has expired' : 'the session token is not valid',
		);
	}
	return checked.claims;
}

/**
 * `GET /api/inbox/ws` where the sockets are held elsewhere (`LiveInboxRouter`,
 * Cloudflare's Inbox objects): the token is checked here, at the upgrade, as
 * `getInboxAPI` does, then the request goes to `accept`, which answers with the
 * accepted socket. The response is rebuilt with headers of its own, so no
 * middleware re-wraps a 101 (observation `cf-worker-room-upgrade-500-on-wrangler-dev`).
 */
export function getRoutedInboxAPI<CustomEnv extends Env>(
	options: ServerOptions<CustomEnv>,
	getRouter: (env: CustomEnv) => LiveInboxRouter,
) {
	return new Hono<{Bindings: CustomEnv}>().get('/ws', setup({serverOptions: options}), async (c) => {
		const env = c.get('config').env as CustomEnv;
		const claims = checkInboxUpgrade(c.req.header('Sec-WebSocket-Protocol'), sessionSecrets(env), Date.now());
		const response = await getRouter(env).accept(c.req.raw, claims);
		return new Response(response.body, {
			status: response.status,
			headers: new Headers(response.headers),
			...({webSocket: (response as {webSocket?: unknown}).webSocket} as object),
		});
	});
}

/**
 * `GET /api/inbox/ws` (ADR-0006 "Live channel"): the live inbox of the account
 * of a session token, in the token's domain. The token is checked BEFORE the
 * socket is accepted, from `Sec-WebSocket-Protocol: missiv-inbox, <token>`: an
 * absent, invalid or expired one is refused 401 (`unauthenticated`), as every
 * other route refuses it, and no socket is opened. An accepted socket is added
 * to the user's live inbox (every new message it can see and every change of
 * its inbox rows is pushed to it), answers `sync` frames and the heartbeat's
 * `ping`, and is closed with `session-expired` (4001) when its token expires,
 * `heartbeat-timeout` (4002) when it sent nothing for three heartbeat
 * intervals (`inboxSocketEvents`).
 */
export function getInboxAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>, live: LiveInboxHost) {
	const {upgradeWebSocket} = options;
	const app = new Hono<{Bindings: CustomEnv}>().get(
		'/ws',
		setup({serverOptions: options}),
		async (c, next) => {
			const secrets = sessionSecrets(c.get('config').env);
			c.set('session', checkInboxUpgrade(c.req.header('Sec-WebSocket-Protocol'), secrets, Date.now()));
			return next();
		},
		upgradeWebSocket((c) => inboxSocketEvents(c.get('config').stores, c.get('session') as SessionClaims, live)),
	);
	return app;
}

/**
 * The events of one accepted socket of the live inbox held in this process
 * (`getInboxAPI`): added to `live` on open, answering each `sync` in turn and
 * `ping` with `pong` at once (the heartbeat, `@missiv/common`'s heartbeat.ts),
 * closed `session-expired` at the token's expiry and `heartbeat-timeout` once
 * it sent nothing for three heartbeat intervals.
 */
export function inboxSocketEvents(stores: SyncStores, claims: SessionClaims, live: LiveInboxHost): WSEvents {
	let connection: LiveConnection | undefined;
	let remove: (() => void) | undefined;
	let expiry: ReturnType<typeof setTimeout> | undefined;
	let idle: IdleWatch | undefined;
	let open = false;
	// each sync is answered in turn, so each `ready` follows its own sync's frames
	let queue: Promise<void> = Promise.resolve();

	function closed() {
		open = false;
		remove?.();
		remove = undefined;
		idle?.stop();
		idle = undefined;
		if (expiry) {
			clearTimeout(expiry);
			expiry = undefined;
		}
	}

	return {
		onOpen(_event, ws) {
			open = true;
			connection = {
				send: (data) => ws.send(data),
				close: (code, reason) => ws.close(code, reason),
			};
			remove = live.connect(claims.domain, claims.account, connection);
			expiry = setTimeout(
				() => {
					connection?.close(INBOX_CLOSE_SESSION_EXPIRED, INBOX_SESSION_EXPIRED_REASON);
					closed();
				},
				Math.max(0, claims.exp - Date.now()),
			);
			idle = watchIdle(() => {
				connection?.close(HEARTBEAT_CLOSE_TIMEOUT, HEARTBEAT_TIMEOUT_REASON);
				closed();
			});
		},
		onMessage(event) {
			const data = event.data;
			idle?.touch();
			if (data === HEARTBEAT_PING) {
				if (open && connection) {
					connection.send(HEARTBEAT_PONG);
				}
				return;
			}
			queue = queue
				.then(async () => {
					if (!open || !connection) {
						return;
					}
					let frame: unknown;
					try {
						frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer));
					} catch {
						frame = undefined;
					}
					const sync = InboxSyncSchema.safeParse(frame);
					if (!sync.success) {
						// 1008: policy violation; nothing but a sync (or a ping) is expected
						connection.close(1008, 'expected a sync frame');
						closed();
						return;
					}
					const target = connection;
					await answerSync(
						stores,
						claims,
						sync.data,
						(frame) => target.send(JSON.stringify(frame)),
						() => open,
					);
				})
				.catch((err) => console.error(`live inbox: a sync failed`, err));
		},
		onClose() {
			closed();
		},
		onError() {
			closed();
		},
	};
}
