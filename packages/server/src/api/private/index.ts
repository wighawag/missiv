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
	ActionUnblockSchema,
	ServerOptions,
} from '../../types.js';
import {refuseReplay, requireAccount, setup} from '../../setup.js';
import {MissivError, validateJSON} from '../../errors.js';
import {conversationIDOf} from 'missiv-common';
import {Env} from '../../env.js';

export function getPrivateChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/sendMessage', validateJSON(ActionSendMessageSchema), async (c) => {
			const action = c.req.valid('json');
			const {account, publicKey} = requireAccount(c, action.domain);
			const storage = c.get('config').storage;

			// the conversation is its members: the recipients, the sender among them
			const members = action.messages.map((message) => message.to);
			if (new Set(members).size !== members.length) {
				throw new MissivError('invalid_request', 'a member is named twice');
			}
			if (!members.includes(account)) {
				throw new MissivError('invalid_request', "the sender's own copy is missing");
			}
			if (action.conversationID !== conversationIDOf(members)) {
				throw new MissivError('invalid_request', 'conversationID is not the ID of its members');
			}
			if (action.messageType === 'encrypted') {
				// a recipient's copy names that recipient's registered key; the sender's own
				// copy names the key its shared secret is with, a member's
				const keys = await storage.publicKeysOf(action.domain, members);
				const memberKeys = new Set(keys.values());
				for (const message of action.messages) {
					const expected =
						message.to === account ? memberKeys.has(message.toPublicKey) : keys.get(message.to) === message.toPublicKey;
					if (!expected) {
						throw new MissivError('conflict', `the copy for ${message.to} is not encrypted to its registered key`);
					}
				}
			}
			const blockers = await storage.blockersOf(action.domain, account, members);
			const deliverTo = new Set(members.filter((member) => !blockers.has(member)));

			await refuseReplay(c);
			const {timestampMS} = await storage.sendMessage(publicKey, account, Date.now(), action, members, deliverTo);
			return c.json({timestampMS});
		})
		.post('/getConversations', validateJSON(ActionGetConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(await c.get('config').storage.getConversations(action.domain, action.namespace, account, action));
		})
		.post('/getAcceptedConversations', validateJSON(ActionGetAcceptedConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(
				await c.get('config').storage.getAcceptedConversations(action.domain, action.namespace, account, action),
			);
		})
		.post('/getUnacceptedConversations', validateJSON(ActionGetUnacceptedConversationsSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			return c.json(
				await c.get('config').storage.getUnacceptedConversations(action.domain, action.namespace, account, action),
			);
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
			await c.get('config').storage.rejectConversation(account, Date.now(), action);
			return c.json({success: true} as const);
		})
		.post('/unblock', validateJSON(ActionUnblockSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').storage.unblock(account, action);
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
