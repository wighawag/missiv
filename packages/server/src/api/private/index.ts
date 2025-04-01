import {Hono} from 'hono';
import {
	ActionAcceptConversationSchema,
	ActionGetAcceptedConversationsSchema,
	ActionGetConversationsSchema,
	ActionGetMessagesSchema,
	ActionGetUnacceptedConversationsSchema,
	ActionMarkAsReadSchema,
	ActionRejectConversationSchema,
	ActionSendMessageSchema,
	ServerOptions,
} from '../../types.js';
import {getAuth, setup} from '../../setup.js';
import {zValidator} from '@hono/zod-validator';

import {Env} from '../../env.js';

export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/sendMessage', zValidator('json', ActionSendMessageSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const timestampMS = Date.now();
			const {account, publicKey} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			const action = c.req.valid('json');

			const result = await storage.sendMessage(publicKey, account, timestampMS, action);
			return c.json(result);
		})
		.post('/getConversations', zValidator('json', ActionGetConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			const result = await storage.getConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getAcceptedConversations', zValidator('json', ActionGetAcceptedConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getUnacceptedConversations', zValidator('json', ActionGetUnacceptedConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/markAsRead', zValidator('json', ActionMarkAsReadSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			await storage.markAsRead(account, action);
			return c.json({success: true});
		})

		.post('/rejectConversation', zValidator('json', ActionRejectConversationSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			await storage.rejectConversation(account, action);
			return c.json({success: true});
		})
		.post('/getMessages', zValidator('json', ActionGetMessagesSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const result = await storage.getMessages(account, action);
			return c.json(result);
		})
		.post('/acceptConversation', zValidator('json', ActionAcceptConversationSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const timestampMS = Date.now();
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			const result = await storage.acceptConversation(account, timestampMS, action);
			return c.json(result);
		});

	return app;
}
