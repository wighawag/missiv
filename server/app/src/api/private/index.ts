import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types';
import {RemoteSQLStorage} from '../../storage/RemoteSQLStorage';
import {zValidator} from '@hono/zod-validator';
import {
	SchemaActionAcceptConversation,
	SchemaActionGetAcceptedConversations,
	SchemaActionGetConversations,
	SchemaActionGetMessages,
	SchemaActionGetUnacceptedConversations,
	SchemaActionMarkAsRead,
	SchemaActionSendMessage,
} from './types';
import {eth_auth, getAuth} from '../auth';

export function getPrivateChatAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB} = options;

	const app = new Hono<{Bindings: Env & {}}>()
		.use(eth_auth({serverOptions: options}))
		.post('/sendMessage', zValidator('json', SchemaActionSendMessage), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
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
		.post('/getConversations', zValidator('json', SchemaActionGetConversations), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const action = c.req.valid('json');
			const result = await storage.getConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getAcceptedConversations', zValidator('json', SchemaActionGetAcceptedConversations), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const action = c.req.valid('json');
			const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/getUnacceptedConversations', zValidator('json', SchemaActionGetUnacceptedConversations), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const action = c.req.valid('json');
			const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
			return c.json(result);
		})
		.post('/markAsRead', zValidator('json', SchemaActionMarkAsRead), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const action = c.req.valid('json');
			await storage.markAsRead(account, action);
			return c.json({success: true});
		})
		.post('/getMessages', zValidator('json', SchemaActionGetMessages), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const action = c.req.valid('json');
			const result = await storage.getMessages(action);
			return c.json(result);
		})
		.post('/acceptConversation', zValidator('json', SchemaActionAcceptConversation), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
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
