// Where each Durable Object of direct messaging is (ADR-0005, ADR-0006): one
// Conversation object per (domain, namespace, conversationID), one Inbox object
// per (domain, user). The name is the JSON of the tuple, so no separator can be
// confused with a part of it, and every name is keyed by the whole tuple, never
// by conversationID alone (ADR-0006 "Identity of a conversation").
import type {Address} from '@missiv/common';
import type {ConversationKey} from '@missiv/server';
import type {CloudflareWorkerEnv} from '../env.js';

/** The (domain, user) an Inbox object belongs to, passed with every call so the object knows itself. */
export type InboxOwner = {domain: string; user: Address};

export function conversationObjectName(key: ConversationKey): string {
	return JSON.stringify(['conversation', key.domain, key.namespace, key.conversationID]);
}

export function inboxObjectName(domain: string, user: Address): string {
	return JSON.stringify(['inbox', domain, user.toLowerCase()]);
}

export function conversationObject(env: CloudflareWorkerEnv, key: ConversationKey) {
	return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationObjectName(key)));
}

export function inboxObject(env: CloudflareWorkerEnv, domain: string, user: Address) {
	return env.INBOXES.get(env.INBOXES.idFromName(inboxObjectName(domain, user)));
}

/** The key of a conversation, without anything else its holder carries. */
export function conversationKeyOf(key: ConversationKey): ConversationKey {
	return {domain: key.domain, namespace: key.namespace, conversationID: key.conversationID};
}

/** How long to wait before retrying a call to another object that failed `attempts` times: 1 s, doubling, at most 5 min. */
export function retryDelayMs(attempts: number): number {
	return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
}
