// Cloudflare's store ports (ADR-0005), as the Worker's routes use them: D1 for
// the KeyDirectory only, behind an in-isolate cache of its lookups; a
// Conversation Durable Object per (domain, namespace, conversationID) as the
// ConversationStore; an Inbox Durable Object per (domain, user) as the Inbox
// and its live side. Every method here is one call to one object (the append
// adds the recipient's cached directory read for the push).
import type {Address, Message} from '@missiv/common';
import {
	cachedKeyDirectory,
	MissivError,
	SQLKeyDirectory,
	type AppendResult,
	type KeyDirectoryCache,
	type LiveInboxRouter,
	type PushRecipient,
	type Stores,
} from '@missiv/server';
import {RemoteD1} from 'remote-sql-d1';
import type {CloudflareWorkerEnv} from '../env.js';
import type {ConversationAppendResult} from './conversation.js';
import {SESSION_CLAIMS_HEADER} from './inbox.js';
import {conversationKeyOf, conversationObject, inboxObject} from './names.js';

export {ServerObjectConversation} from './conversation.js';
export {ServerObjectInbox, SESSION_CLAIMS_HEADER} from './inbox.js';
export {conversationObject, conversationObjectName, inboxObject, inboxObjectName} from './names.js';

/**
 * How long an isolate answers a key lookup from its cache (`cachedKeyDirectory`):
 * 5 s, so a key replacement registered on another isolate is seen within that
 * long (see the cache's decisions).
 */
export const KEY_CACHE_TTL_MS = 5_000;

/** The position a conversation-list cursor (`<lastMessageAt>:<conversationID>`) names; 400 for a malformed one. */
export function parseConversationCursor(cursor: string | undefined): [number, string] | undefined {
	if (cursor === undefined) {
		return undefined;
	}
	const separator = cursor.indexOf(':');
	const time = Number(cursor.slice(0, separator));
	if (separator < 0 || !Number.isInteger(time)) {
		throw new MissivError('invalid_request', 'malformed cursor');
	}
	return [time, cursor.slice(separator + 1)];
}

export function createCloudflareStores(env: CloudflareWorkerEnv, cache: KeyDirectoryCache): Stores {
	const keys = cachedKeyDirectory(new SQLKeyDirectory(new RemoteD1(env.DB)), {cache, ttlMs: KEY_CACHE_TTL_MS});
	const inbox = (domain: string, user: Address) => inboxObject(env, domain, user);
	const owner = (domain: string, user: Address) => ({domain, user});

	/** the recipient to push to: their app origin, from their current key set, when they are registered */
	async function pushTo(domain: string, recipient: Address): Promise<PushRecipient[]> {
		const {domainUser} = await keys.getDomainUser(domain, recipient);
		return domainUser ? [{address: recipient, appOrigin: domainUser.appOrigin}] : [];
	}

	return {
		keys,
		conversations: {
			async append(message, members, now): Promise<AppendResult> {
				const key = conversationKeyOf(message);
				const result = (await conversationObject(env, key).append(
					key,
					message,
					members,
					now,
				)) as ConversationAppendResult;
				if (result.status !== 'appended') {
					return result;
				}
				return {
					...result,
					pushTo: result.hiddenFrom ? [] : await pushTo(message.domain, members.recipient),
					// the Conversation object updated both inboxes, and retries what failed
					pendingInboxUpdates: [],
				};
			},
			async listMessages(reader, key, page) {
				return (await conversationObject(env, conversationKeyOf(key)).listMessages(
					conversationKeyOf(key),
					reader,
					page,
				)) as {messages: Message[]; hasMore: boolean};
			},
		},
		inbox: {
			async update(update) {
				await inbox(update.domain, update.user).update(owner(update.domain, update.user), update);
			},
			async getConversation(user, key) {
				return inbox(key.domain, user).getConversation(owner(key.domain, user), conversationKeyOf(key));
			},
			async listConversations(user, scope, page) {
				return inbox(scope.domain, user).listConversations(
					owner(scope.domain, user),
					{domain: scope.domain, namespace: scope.namespace},
					{status: page.status, before: parseConversationCursor(page.before), limit: page.limit},
				);
			},
			async accept(user, key) {
				await inbox(key.domain, user).accept(owner(key.domain, user), conversationKeyOf(key));
			},
			async reject(user, key, other, now) {
				await inbox(key.domain, user).reject(owner(key.domain, user), conversationKeyOf(key), other, now);
			},
			async unblock(user, domain, blocked) {
				await inbox(domain, user).unblock(owner(domain, user), blocked);
			},
			async changes(user, domain, page) {
				return inbox(domain, user).changes(owner(domain, user), page);
			},
			async markRead(user, key, seq) {
				await inbox(key.domain, user).markRead(owner(key.domain, user), conversationKeyOf(key), seq);
			},
		},
	};
}

/** The live channel's router (`LiveInboxRouter`): each socket goes to its user's Inbox object, which holds it and pushes to it. */
export function createLiveInboxRouter(env: CloudflareWorkerEnv): LiveInboxRouter {
	return {
		isOnline(domain, user) {
			return inboxObject(env, domain, user).isOnline({domain, user});
		},
		async accept(request, claims) {
			const headers = new Headers(request.headers);
			headers.set(SESSION_CLAIMS_HEADER, JSON.stringify(claims));
			return inboxObject(env, claims.domain, claims.account).fetch(request.url, {headers});
		},
	};
}
