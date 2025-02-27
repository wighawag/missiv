import {Hono} from 'hono';
import {ServerOptions} from '../../types.js';
import {getAuth, setup} from '../../setup.js';
import {typiaValidator} from '@hono/typia-validator';
import {createValidate} from 'typia';
import {
	ActionAcceptConversation,
	ActionGetAcceptedConversations,
	ActionGetConversations,
	ActionGetMessages,
	ActionGetUnacceptedConversations,
	ActionMarkAsRead,
	ActionSendMessage,
	ActionRejectConversation,
} from 'missiv-common';
import {Env} from '../../env.js';

export function getPrivateChatAPI<Bindings extends Env>(options: ServerOptions<Bindings>) {
	const app = new Hono<{Bindings: Bindings}>()
		.use(setup({serverOptions: options}))
		.post('/sendMessage', typiaValidator('json', createValidate<ActionSendMessage>()), async (c) => {
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
		.post('/getConversations', typiaValidator('json', createValidate<ActionGetConversations>()), async (c) => {
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
		.post(
			'/getAcceptedConversations',
			typiaValidator('json', createValidate<ActionGetAcceptedConversations>()),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				const action = c.req.valid('json');

				const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			},
		)
		.post(
			'/getUnacceptedConversations',
			typiaValidator('json', createValidate<ActionGetUnacceptedConversations>()),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				const action = c.req.valid('json');

				const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			},
		)
		.post('/markAsRead', typiaValidator('json', createValidate<ActionMarkAsRead>()), async (c) => {
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

		.post('/rejectConversation', typiaValidator('json', createValidate<ActionRejectConversation>()), async (c) => {
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
		.post('/getMessages', typiaValidator('json', createValidate<ActionGetMessages>()), async (c) => {
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
		.post('/acceptConversation', typiaValidator('json', createValidate<ActionAcceptConversation>()), async (c) => {
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
