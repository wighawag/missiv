import {Env} from '@missiv/server';
import type {ServerObjectConversation} from './stores/conversation.js';
import type {ServerObjectInbox} from './stores/inbox.js';

export type CloudflareWorkerEnv = Env & {
	/** D1: the KeyDirectory (key sets, domain users) and the replay set of `/session` and `register` */
	DB: D1Database;
	ROOMS: DurableObjectNamespace;
	LIMITERS: DurableObjectNamespace;
	/** a Conversation object per (domain, namespace, conversationID): its messages, by seq */
	CONVERSATIONS: DurableObjectNamespace<ServerObjectConversation>;
	/** an Inbox object per (domain, user): its conversation rows, its blocks, its live sockets */
	INBOXES: DurableObjectNamespace<ServerObjectInbox>;
	LOGFLARE_API_KEY?: string;
	LOGFLARE_SOURCE?: string;
	NAMED_LOGS?: string;
	NAMED_LOGS_LEVEL?: string;
};
