import {Hono} from 'hono';
import {
	ActionAcceptSchema,
	ActionGetSettingsSchema,
	ActionListConversationsSchema,
	ActionListMessagesSchema,
	ActionMarkReadSchema,
	ActionRejectSchema,
	ActionSetSettingsSchema,
	ActionUnblockSchema,
	ServerOptions,
} from '../../types.js';
import {requireAccount, setup} from '../../setup.js';
import {validateJSON} from '../../errors.js';
import {
	MAX_PAGE_SIZE,
	type ResponseGetSettings,
	type ResponseListConversations,
	type ResponseListMessages,
	type ResponseSetSettings,
} from '@missiv/common';
import {Env} from '../../env.js';
import {otherMemberOf} from '../conversation.js';
import {deliverConversation} from '../../delivery.js';
import type {Context} from 'hono';

/**
 * The reads and the status changes of direct messaging (ADR-0006 "API"), every
 * one on a session token: a member's messages by seq, its conversation list
 * from its inbox index, accept, reject (and block), unblock, markRead (and its
 * read receipt), and the account's settings in the domain. Sends are
 * `/api/messages/send`.
 */
export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	/** the changed inbox row to the user's own sockets, after the response */
	function changed(c: Context, user: `0x${string}`, key: {domain: string; namespace: string; conversationID: string}) {
		const delivered = deliverConversation(options, c.get('config').stores, user, {
			domain: key.domain,
			namespace: key.namespace,
			conversationID: key.conversationID,
		});
		if (options.waitUntil) {
			options.waitUntil(c, delivered);
		}
	}

	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/listMessages', validateJSON(ActionListMessagesSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			otherMemberOf(action.conversationID, account);
			const page = await c.get('config').stores.conversations.listMessages(account, action, {
				after: action.after,
				before: action.before,
				limit: action.limit ?? MAX_PAGE_SIZE,
			});
			return c.json(page satisfies ResponseListMessages);
		})
		.post('/listConversations', validateJSON(ActionListConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const page = await c.get('config').stores.inbox.listConversations(account, action, {
				status: action.status,
				before: action.before,
				limit: action.limit ?? MAX_PAGE_SIZE,
			});
			return c.json(page satisfies ResponseListConversations);
		})
		.post('/accept', validateJSON(ActionAcceptSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			otherMemberOf(action.conversationID, account);
			await c.get('config').stores.inbox.accept(account, action);
			changed(c, account, action);
			return c.json({success: true} as const);
		})
		.post('/reject', validateJSON(ActionRejectSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const other = otherMemberOf(action.conversationID, account);
			await c.get('config').stores.inbox.reject(account, action, other, Date.now());
			changed(c, account, action);
			return c.json({success: true} as const);
		})
		.post('/unblock', validateJSON(ActionUnblockSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').stores.inbox.unblock(account, action.domain, action.address);
			return c.json({success: true} as const);
		})
		.post('/markRead', validateJSON(ActionMarkReadSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const other = otherMemberOf(action.conversationID, account);
			await c.get('config').stores.inbox.markRead(account, action, action.seq);
			changed(c, account, action);
			// the other member's row may hold the read receipt now: pushed only where
			// this process holds the sockets, and only when both share read receipts
			// (else the row did not change, and a frame at that moment would tell its
			// timing)
			if (options.liveInbox) {
				const inbox = c.get('config').stores.inbox;
				const [mine, theirs] = await Promise.all([
					inbox.getSettings(account, action.domain),
					inbox.getSettings(other, action.domain),
				]);
				if (mine.readReceipts && theirs.readReceipts) {
					changed(c, other, action);
				}
			}
			return c.json({success: true} as const);
		})
		.post('/getSettings', validateJSON(ActionGetSettingsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const settings = await c.get('config').stores.inbox.getSettings(account, action.domain);
			return c.json({settings} satisfies ResponseGetSettings);
		})
		.post('/setSettings', validateJSON(ActionSetSettingsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const settings = await c.get('config').stores.inbox.setSettings(account, action.domain, {
				readReceipts: action.readReceipts,
			});
			return c.json({settings} satisfies ResponseSetSettings);
		});

	return app;
}
