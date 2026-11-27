import {Hono} from 'hono';
import {
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_SESSION_EXPIRED_REASON,
	INBOX_WS_PROTOCOL,
	InboxSyncSchema,
	MAX_PAGE_SIZE,
	membersOfConversationID,
	parseInboxConversationKey,
	type InboxServerFrame,
	type InboxSync,
} from '@missiv/common';
import type {ServerOptions} from '../../types.js';
import type {Env} from '../../env.js';
import {sessionSecrets, setup} from '../../setup.js';
import {MissivError} from '../../errors.js';
import {verifySessionToken, type SessionClaims} from '../../session.js';
import type {LiveConnection, LiveInboxHost, Stores} from '../../stores/ports.js';

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
 */
async function answerSync(
	stores: Stores,
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
			}
			if (!page.hasMore || page.messages.length === 0) {
				break;
			}
		}
		const row = await stores.inbox.getConversation(claims.account, conversation);
		if (row) {
			send({type: 'conversation', conversation: row});
		}
	}
	if (isOpen()) {
		send({type: 'ready'});
	}
}

/**
 * `GET /api/inbox/ws` (ADR-0006 "Live channel"): the live inbox of the account
 * of a session token, in the token's domain. The token is checked BEFORE the
 * socket is accepted, from `Sec-WebSocket-Protocol: missiv-inbox, <token>`: an
 * absent, invalid or expired one is refused 401 (`unauthenticated`), as every
 * other route refuses it, and no socket is opened. An accepted socket is added
 * to the user's live inbox (every new message it can see and every change of
 * its inbox rows is pushed to it), answers `sync` frames, and is closed with
 * `session-expired` (4001) when its token expires.
 */
export function getInboxAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>, live: LiveInboxHost) {
	const {upgradeWebSocket} = options;
	const app = new Hono<{Bindings: CustomEnv}>().get(
		'/ws',
		setup({serverOptions: options}),
		async (c, next) => {
			const secrets = sessionSecrets(c.get('config').env);
			const token = offeredToken(c.req.header('Sec-WebSocket-Protocol'));
			if (!token) {
				throw new MissivError(
					'unauthenticated',
					`a session token is required, offered as the WebSocket protocol after ${INBOX_WS_PROTOCOL}`,
				);
			}
			const checked = verifySessionToken(token, secrets, Date.now());
			if (!checked.ok) {
				throw new MissivError(
					'unauthenticated',
					checked.reason === 'expired' ? 'the session token has expired' : 'the session token is not valid',
				);
			}
			c.set('session', checked.claims);
			return next();
		},
		upgradeWebSocket((c) => {
			const claims = c.get('session') as SessionClaims;
			const {stores} = c.get('config');
			let connection: LiveConnection | undefined;
			let remove: (() => void) | undefined;
			let expiry: ReturnType<typeof setTimeout> | undefined;
			let open = false;
			// each sync is answered in turn, so each `ready` follows its own sync's frames
			let queue: Promise<void> = Promise.resolve();

			function closed() {
				open = false;
				remove?.();
				remove = undefined;
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
				},
				onMessage(event) {
					const data = event.data;
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
								// 1008: policy violation; nothing but a sync is expected
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
		}),
	);
	return app;
}
