// missiv 0.6's API (ADR-0006): registrations signed by the user's Ed25519
// signing key, everything else on a session token, a send one message
// (`messages/send`) signed once by the sender (the server verifies it against
// the sender's current key set: no request signature, no replay set), stored
// once under the conversation's next seq. A read is the catch-up an open
// conversation does: `listMessages` after the last seq this user has of the
// conversation (so, once caught up, only what is new); `0.6-page` reads the
// newest page every time instead (what opening a conversation costs, and what
// every 0.5 read cost). Users, registration and sends are the client-server
// tests' own (`test/client-server/test/setup.ts`), over real HTTP.
//
// Sends are `clear` (an introduction) carrying the scenario's placeholder
// content, as the 0.5 adapter sent a placeholder: the server's work is the
// same for either scheme (the schema, the content's SHA-256 and the Ed25519
// verification, one row), and the client's encryption stays out of the numbers.
import {
	conversationIDOf,
	INBOX_WS_PATH,
	INBOX_WS_PROTOCOL,
	inboxConversationKey,
	MAX_PAGE_SIZE,
	type InboxServerFrame,
} from '@missiv/common';
import type {API} from '@missiv/client';
import WebSocket from 'ws';
import {createRemoteActions, createUser, DOMAIN, type TestUser} from '../../../client-server/test/setup.js';
import {joinRoom} from './rooms.js';
import type {Adapter, AdapterFactory, InboxConnection, InboxPoller, LoadUser, Target} from './types.js';

type User = LoadUser & TestUser;

export function v0_6(options: {readNewestPage?: boolean} = {}): AdapterFactory {
	return (target) => {
		const actions = createRemoteActions(target.url);
		/** the last seq each user has of each conversation, the cursor of its next read */
		const cursors = new Map<string, number>();

		const asUser = (user: LoadUser) => user as User;
		const other = (conversation: {members: readonly [LoadUser, LoadUser]}, user: LoadUser) =>
			conversation.members[0] === user ? conversation.members[1] : conversation.members[0];

		const adapter: Adapter = {
			name: options.readNewestPage ? '0.6-page' : '0.6',
			room: `@${DOMAIN}`,
			async createUser() {
				return createUser();
			},
			async register(user) {
				await actions.register(asUser(user));
			},
			async openConversation(a, b) {
				await actions.send({from: asUser(a), to: asUser(b), content: 'hello'});
				const id = conversationIDOf([a.address, b.address]);
				await actions.accept(asUser(b), id);
				return {id, members: [a, b]};
			},
			async send(from, conversation, content) {
				await actions.send({from: asUser(from), to: asUser(other(conversation, from)), content});
			},
			async read(user, conversation) {
				const key = `${user.address}:${conversation.id}`;
				const after = options.readNewestPage ? undefined : cursors.get(key);
				const messages = await actions.messages(asUser(user), conversation.id, after !== undefined ? {after} : {});
				if (messages.length > 0) {
					cursors.set(key, Math.max(after ?? 0, messages[messages.length - 1].seq));
				} else if (after === undefined) {
					cursors.set(key, 0);
				}
				return messages.length;
			},
			async listConversations(user) {
				return (await actions.conversations(asUser(user))).length;
			},
			async openInbox(user) {
				const {token} = await actions.api.getSession(DOMAIN, {privateKey: asUser(user).keySet.signing.privateKey});
				return openInbox(target, token);
			},
			openPoller(user) {
				return poller(actions.api, asUser(user));
			},
			joinRoom(user, room, joinOptions) {
				return joinRoom(target, asUser(user), room, joinOptions);
			},
		};
		return adapter;
	};
}

/**
 * A socket on the live inbox channel with a session token (presented at the
 * upgrade, as `@missiv/client` presents it), resolved once open.
 */
async function openInbox(target: Target, token: string): Promise<InboxConnection> {
	const ws = new WebSocket(`${target.url.replace(/^http/, 'ws')}${INBOX_WS_PATH}`, [INBOX_WS_PROTOCOL, token]);
	const listeners: ((content: string, at: number) => void)[] = [];
	ws.on('message', (raw) => {
		const receivedAt = performance.now();
		const frame = JSON.parse(raw.toString()) as InboxServerFrame;
		if (frame.type === 'message') {
			listeners.forEach((l) => l(frame.message.content, receivedAt));
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
	return {
		onMessage(listener) {
			listeners.push(listener);
		},
		close() {
			return new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				ws.once('close', () => resolve());
				ws.close();
			});
		},
	};
}

/**
 * A client on the polling transport, as `@missiv/client`'s channel polls: from
 * the inbox version it reached, and for each changed row the messages after
 * the last seq it has of that conversation (the first poll only learns them).
 */
function poller(api: API, user: TestUser): InboxPoller {
	const as = {privateKey: user.keySet.signing.privateKey};
	let version = 0;
	let looked = false;
	const held = new Map<string, number>();
	return {
		async poll() {
			const messages: {content: string; receivedAt: number}[] = [];
			let changed = false;
			for (;;) {
				const answer = await api.inboxChanges({type: 'inboxChanges', domain: DOMAIN, since: version}, as);
				if ('unchanged' in answer) {
					version = answer.version;
					break;
				}
				changed = true;
				for (const row of answer.conversations) {
					const key = inboxConversationKey(row);
					let after = held.get(key) ?? 0;
					if (looked) {
						while (row.lastSeq > after) {
							const page = await api.listMessages(
								{
									type: 'listMessages',
									domain: DOMAIN,
									namespace: row.namespace,
									conversationID: row.conversationID,
									after,
									limit: MAX_PAGE_SIZE,
								},
								as,
							);
							const receivedAt = performance.now();
							for (const message of page.messages) {
								messages.push({content: message.content, receivedAt});
								after = Math.max(after, message.seq);
							}
							if (!page.hasMore || page.messages.length === 0) break;
						}
					}
					held.set(key, Math.max(after, row.lastSeq));
				}
				version = answer.version;
				if (!answer.hasMore) break;
			}
			looked = true;
			return {changed, messages};
		},
	};
}
