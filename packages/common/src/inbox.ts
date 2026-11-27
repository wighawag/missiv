// The Inbox's live channel (ADR-0006 "Live channel"): one WebSocket per
// signed-in client, `GET /api/inbox/ws`, on which the server pushes the new
// messages and conversation updates of the account in the session token's
// domain (every namespace of it), and answers a `sync` with what the client
// missed. Sends stay HTTP.
//
// Decisions recorded here (the frames are ADR-0006's; these are not):
// - The session token is presented AT UPGRADE in `Sec-WebSocket-Protocol`, as
//   the second of two protocols: `missiv-inbox, <token>`. The server selects
//   `missiv-inbox` (a browser fails a handshake whose answer names no protocol
//   it offered), so the token is never echoed back. A token is base64url, a dot
//   and base64url: every character is a valid protocol token. The one-shot
//   ticket ADR-0006 allows as an alternative is not built (it costs an HTTP call
//   and server-side state per connection; a header needs neither).
// - A socket carries one domain (the token's) and every namespace in it, so one
//   socket serves all of a client's stores. A conversation is named in a `sync`
//   by `inboxConversationKey` (`<namespace>:<conversationID>`; a conversationID
//   never contains `:`, so the last `:` splits it whatever the namespace).
// - Session expiry closes the socket with code 4001 and reason
//   `session-expired` (4000-4999 are the application's own codes, RFC 6455
//   7.4.2); the client renews its token and reconnects at once, then syncs.
// - Frames may arrive in any order and more than once (a live frame and a
//   sync's answer can carry the same message): a client applies messages by seq
//   (each seq once) and conversations by `lastSeq` (never back).
//
// The inbox version and the polling transport (ADR-0006 "Amendment: the inbox
// version and polling"):
// - The INBOX VERSION is a counter per (domain, user): every change of one of
//   the user's inbox rows in the domain (a message's update that moves it,
//   accept, reject, markRead that move it) gives that row the next version, and
//   the inbox's version is its highest row's. An update that changes nothing (a
//   repeated or reordered `Inbox.update`, an accept of an accepted row) takes
//   none, and `unblock` takes none: it changes no row (the block list is not
//   rows a client lists). Every row carries its version (`Conversation.version`),
//   so a `conversation` frame carries it and a client that moves from the
//   socket to polling polls from the highest one it saw.
// - `POST /api/inbox/changes {domain, since}` answers `{version, unchanged:
//   true}` when no row changed after `since`, else the rows that did, oldest
//   change first, a page at a time (`hasMore`: poll again at once from the
//   answered `version`, the last row's). A `since` above the inbox's version
//   (a server whose database was reset) is answered as `since` 0: every row.
//   The client then reads the messages it lacks with `listMessages {after}`.
// - Which transports a deployment offers is `INBOX_TRANSPORTS` (`socket,poll`
//   by default): a route that is off answers 404, and a client in `auto`
//   adapts.
import {z} from 'zod';
import type {Message} from './message.js';
import type {Conversation} from './index.js';

/** The path of the live channel, below the server's endpoint. */
export const INBOX_WS_PATH = '/api/inbox/ws';
/** The path of the polling transport (`ActionInboxChanges`), below the server's endpoint. */
export const INBOX_CHANGES_PATH = '/api/inbox/changes';
/** How a deployment may deliver the live inbox: the socket (`INBOX_WS_PATH`) and polling (`INBOX_CHANGES_PATH`). */
export const INBOX_TRANSPORTS = ['socket', 'poll'] as const;
export type InboxTransport = (typeof INBOX_TRANSPORTS)[number];
/** The protocol the server selects; the client offers it first, its session token second. */
export const INBOX_WS_PROTOCOL = 'missiv-inbox';
/** The close code of a socket whose session token expired: renew the token and reconnect. */
export const INBOX_CLOSE_SESSION_EXPIRED = 4001;
/** The close reason that goes with `INBOX_CLOSE_SESSION_EXPIRED`. */
export const INBOX_SESSION_EXPIRED_REASON = 'session-expired';
/** At most this many conversations in one `sync`. */
export const MAX_SYNC_CONVERSATIONS = 1000;

/** How a `sync` names a conversation of the socket's domain. */
export function inboxConversationKey(conversation: {namespace: string; conversationID: string}): string {
	return `${conversation.namespace}:${conversation.conversationID}`;
}

/** The namespace and conversationID of an `inboxConversationKey`, or undefined for a malformed one. */
export function parseInboxConversationKey(key: string): {namespace: string; conversationID: string} | undefined {
	const separator = key.lastIndexOf(':');
	if (separator < 0 || separator === key.length - 1) {
		return undefined;
	}
	return {namespace: key.slice(0, separator), conversationID: key.slice(separator + 1)};
}

/**
 * What the client may send: `sync`, the last seq it holds of each conversation
 * (by `inboxConversationKey`). The server answers, conversation by
 * conversation, every message after that seq the account can see (`message`
 * frames, in seq order) and the account's inbox row (`conversation`), then
 * `ready`. A conversation the account is not a member of is skipped. Syncs
 * are answered in the order they are sent, each with its own `ready`.
 */
export const InboxSyncSchema = z.object({
	type: z.literal('sync'),
	since: z
		.record(z.string().max(64 + 1 + 256), z.number().int().nonnegative())
		.refine((since) => Object.keys(since).length <= MAX_SYNC_CONVERSATIONS, {
			message: `at most ${MAX_SYNC_CONVERSATIONS} conversations per sync`,
		}),
});
export type InboxSync = z.infer<typeof InboxSyncSchema>;
export type InboxClientFrame = InboxSync;

/**
 * What the server pushes: a new message the account can see (its own included,
 * to its other devices), its inbox row after a change (a message, accept,
 * reject, markRead), and `ready` once a `sync` is answered.
 */
export type InboxServerFrame =
	| {type: 'message'; message: Message}
	| {type: 'conversation'; conversation: Conversation}
	| {type: 'ready'};
