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
import {refuseReplay, requireAccount, setup} from '../../setup.js';
import {validateJSON} from '../../errors.js';
import {Env} from '../../env.js';

export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/sendMessage', validateJSON(ActionSendMessageSchema), async (c) => {
			const action = c.req.valid('json');
			const {account, publicKey} = requireAccount(c, action.domain);
			await refuseReplay(c);
			const {timestampMS} = await c.get('config').storage.sendMessage(publicKey, account, Date.now(), action);
			return c.json({timestampMS});
		})
		.post('/getConversations', validateJSON(ActionGetConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.getConversations(action.domain, action.namespace, account));
		})
		.post('/getAcceptedConversations', validateJSON(ActionGetAcceptedConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.getAcceptedConversations(action.domain, action.namespace, account));
		})
		.post('/getUnacceptedConversations', validateJSON(ActionGetUnacceptedConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.getUnacceptedConversations(action.domain, action.namespace, account));
		})
		.post('/markAsRead', validateJSON(ActionMarkAsReadSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').storage.markAsRead(account, action);
			return c.json({success: true} as const);
		})
		.post('/rejectConversation', validateJSON(ActionRejectConversationSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').storage.rejectConversation(account, action);
			return c.json({success: true} as const);
		})
		.post('/getMessages', validateJSON(ActionGetMessagesSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.getMessages(account, action));
		})
		.post('/acceptConversation', validateJSON(ActionAcceptConversationSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.acceptConversation(account, Date.now(), action));
		});

	return app;
}
