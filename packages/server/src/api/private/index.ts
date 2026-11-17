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
import {MissivError, validateJSON} from '../../errors.js';

import {Env} from '../../env.js';

export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/sendMessage', validateJSON(ActionSendMessageSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const timestampMS = Date.now();
			const {account, publicKey} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}
			if (!publicKey) {
				throw new MissivError('unauthenticated', 'no key signed this request');
			}

			const action = c.req.valid('json');

			const result = await storage.sendMessage(publicKey, account, timestampMS, action);
			return c.json(result);
		})
		.post('/getConversations', validateJSON(ActionGetConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			const result = await storage.getConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getAcceptedConversations', validateJSON(ActionGetAcceptedConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getUnacceptedConversations', validateJSON(ActionGetUnacceptedConversationsSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/markAsRead', validateJSON(ActionMarkAsReadSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			await storage.markAsRead(account, action);
			return c.json({success: true});
		})

		.post('/rejectConversation', validateJSON(ActionRejectConversationSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			await storage.rejectConversation(account, action);
			return c.json({success: true});
		})
		.post('/getMessages', validateJSON(ActionGetMessagesSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const result = await storage.getMessages(account, action);
			return c.json(result);
		})
		.post('/acceptConversation', validateJSON(ActionAcceptConversationSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const timestampMS = Date.now();
			const {account} = getAuth(c);
			if (!account) {
				throw new MissivError('unauthenticated', 'no registered key signed this request');
			}

			const action = c.req.valid('json');

			const result = await storage.acceptConversation(account, timestampMS, action);
			return c.json(result);
		});

	return app;
}
