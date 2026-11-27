import {Hono} from 'hono';
import {
	ActionAcceptSchema,
	ActionListConversationsSchema,
	ActionListMessagesSchema,
	ActionMarkReadSchema,
	ActionRejectSchema,
	ActionUnblockSchema,
	ServerOptions,
} from '../../types.js';
import {requireAccount, setup} from '../../setup.js';
import {validateJSON} from '../../errors.js';
import {MAX_PAGE_SIZE, type ResponseListConversations, type ResponseListMessages} from '@missiv/common';
import {Env} from '../../env.js';
import {otherMemberOf} from '../conversation.js';

/**
 * The reads and the status changes of direct messaging (ADR-0006 "API"), every
 * one on a session token: a member's messages by seq, its conversation list
 * from its inbox index, accept, reject (and block), unblock, markRead. Sends are
 * `/api/messages/send`.
 */
export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
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
			return c.json({success: true} as const);
		})
		.post('/reject', validateJSON(ActionRejectSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			const other = otherMemberOf(action.conversationID, account);
			await c.get('config').stores.inbox.reject(account, action, other, Date.now());
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
			otherMemberOf(action.conversationID, account);
			await c.get('config').stores.inbox.markRead(account, action, action.seq);
			return c.json({success: true} as const);
		});

	return app;
}
