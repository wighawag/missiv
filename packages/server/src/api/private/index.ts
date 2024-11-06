import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types.js';
import {getAuth, setup} from '../../setup.js';

export function getPrivateChatAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>()
		.use(setup({serverOptions: options}))
		.post(
			'/sendMessage',
			// TODO typia Validation
			// zValidator('json', SchemaActionSendMessage),
			async (c) => {
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

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.sendMessage(publicKey, account, timestampMS, action);
				return c.json(result);
			},
		)
		.post(
			'/getConversations',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetConversations),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;
				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getConversations(action.domain, action.namespace, account);
				return c.json(result);
			},
		)
		.post(
			'/getAcceptedConversations',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetAcceptedConversations),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			},
		)
		.post(
			'/getUnacceptedConversations',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetUnacceptedConversations),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			},
		)
		.post(
			'/markAsRead',
			// TODO typia Validation
			// zValidator('json', SchemaActionMarkAsRead),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				await storage.markAsRead(account, action);
				return c.json({success: true});
			},
		)
		.post(
			'/getMessages',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetMessages),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getMessages(action);
				return c.json(result);
			},
		)
		.post(
			'/acceptConversation',
			// TODO typia Validation
			// zValidator('json', SchemaActionAcceptConversation),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				const timestampMS = Date.now();
				const {account} = getAuth(c);
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.acceptConversation(account, timestampMS, action);
				return c.json(result);
			},
		);

	return app;
}
