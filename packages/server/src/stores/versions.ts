// The inbox versions one process knows (Node.js, Bun), so a poll of an inbox
// that did not change since the client's version (`POST /api/inbox/changes`,
// the polling transport) is answered `unchanged` from memory, with no
// database read. The SQL read stays the source: a version is remembered only
// from what `Inbox.changes` read, and forgotten after every write of this
// process that may move it (an append moves both members', an update, accept,
// reject the user's, a markRead the user's and the other member's, whose row
// takes the read receipt), so the next poll reads it again.
//
// Decisions recorded here:
// - Only a process that is the deployment's only one may answer from memory: a
//   write by another instance would not reach it, and its answer would stay
//   `unchanged`. `createServer` uses it where the process holds the live
//   inbox's sockets itself (`ServerOptions.liveInbox`) AND offers the socket
//   transport (`INBOX_TRANSPORTS`): a socket in process without a bus already
//   means one instance, while `INBOX_TRANSPORTS=poll` is the setting for
//   several (ADR-0005), whose every poll then reads its version from SQL (one
//   lookup on idx_inbox_version). An explicit setting was the alternative; it
//   would let a misconfigured multi-instance deployment drop messages, this
//   costs a single poll-only instance one indexed read per poll.
// - A version read while a write of the same inbox is in flight is not kept
//   (each entry counts the writes that forgot it), so a read that raced a write
//   cannot be remembered after the write forgot it.
// - At most `maxEntries` inboxes (default 100 000), the least recently used
//   forgotten first: a forgotten inbox costs one read on its next poll.
import {membersOfConversationID, type Address} from '@missiv/common';
import type {InboxChanges, Stores} from './ports.js';

export type InboxVersionCache = {
	/**
	 * `stores` whose writes forget the versions they may move and whose
	 * `Inbox.changes` answers `unchanged` from memory when `answer()` is true
	 * (asked at each poll; it still learns and forgets when false)
	 */
	wrap(stores: Stores, options: {answer: () => boolean}): Stores;
	/** forget every version (the database was reset under it); a read in flight is not kept */
	clear(): void;
	/** how many inboxes it remembers, for tests and metrics */
	readonly size: number;
};

type Entry = {version?: number; writes: number};

export function createInboxVersionCache(options: {maxEntries?: number} = {}): InboxVersionCache {
	const maxEntries = options.maxEntries ?? 100_000;
	const entries = new Map<string, Entry>();
	const keyOf = (domain: string, user: Address) => `${domain}\n${user.toLowerCase()}`;

	function touch(key: string): Entry {
		let entry = entries.get(key);
		if (entry) {
			entries.delete(key);
		} else {
			entry = {writes: 0};
			if (entries.size >= maxEntries) {
				const oldest = entries.keys().next();
				if (!oldest.done) entries.delete(oldest.value);
			}
		}
		entries.set(key, entry);
		return entry;
	}

	function forget(domain: string, user: Address) {
		const entry = entries.get(keyOf(domain, user));
		if (entry) {
			entry.version = undefined;
			entry.writes++;
		}
	}

	/** run a write, then forget the versions it may have moved (also when it failed: it may have committed) */
	async function writing<T>(write: Promise<T>, inboxes: Array<[string, Address]>): Promise<T> {
		try {
			return await write;
		} finally {
			for (const [domain, user] of inboxes) forget(domain, user);
		}
	}

	return {
		get size() {
			return entries.size;
		},
		clear() {
			entries.clear();
		},
		wrap(stores, {answer}) {
			const {conversations, inbox} = stores;
			return {
				keys: stores.keys,
				conversations: {
					append: (message, members, now) =>
						writing(conversations.append(message, members, now), [
							[message.domain, members.sender],
							[message.domain, members.recipient],
						]),
					listMessages: (reader, key, page) => conversations.listMessages(reader, key, page),
				},
				inbox: {
					update: (update) => writing(inbox.update(update), [[update.domain, update.user]]),
					getConversation: (user, key) => inbox.getConversation(user, key),
					listConversations: (user, scope, page) => inbox.listConversations(user, scope, page),
					accept: (user, key) => writing(inbox.accept(user, key), [[key.domain, user]]),
					reject: (user, key, other, now) => writing(inbox.reject(user, key, other, now), [[key.domain, user]]),
					// changes no row, so no version
					unblock: (user, domain, blocked) => inbox.unblock(user, domain, blocked),
					// the reader's row, and the other member's (its read receipt)
					markRead: (user, key, seq) =>
						writing(
							inbox.markRead(user, key, seq),
							(membersOfConversationID(key.conversationID) ?? [user]).map(
								(member) => [key.domain, member] as [string, Address],
							),
						),
					getSettings: (user, domain) => inbox.getSettings(user, domain),
					// changes no row (a row's otherReadSeq is shown as 0 to a user that
					// shares none, until the row changes), so no version
					setSettings: (user, domain, settings) => inbox.setSettings(user, domain, settings),
					async changes(user, domain, page): Promise<InboxChanges> {
						const key = keyOf(domain, user);
						const entry = touch(key);
						if (entry.version !== undefined && entry.version === page.since && answer()) {
							return {version: entry.version, unchanged: true};
						}
						const writes = entry.writes;
						const answered = await inbox.changes(user, domain, page);
						// the inbox's own version (not a page's last row), read with no write of this process in between
						const complete = 'unchanged' in answered || !answered.hasMore;
						if (complete && entries.get(key) === entry && entry.writes === writes) {
							entry.version = answered.version;
						}
						return answered;
					},
				},
			};
		},
	};
}
