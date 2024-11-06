import {beforeAll, expect, test} from 'vitest';
import {App, createServer} from './index.js';
import {hc} from 'hono/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';

const dbCLient = createClient({url: ':memory:'});
const remoteSQL = new RemoteLibSQL(dbCLient);
const app = createServer({
	getDB() {
		return remoteSQL;
	},
	getEnv() {
		return {
			DEV: 'true',
		};
	},
	getRoom() {
		throw new Error(`no getRoom implemented in test`);
	},
	upgradeWebSocket() {
		// throw new Error(`no websocket implemented in test`);
		return (() => {}) as any;
	},
});
const client = hc<App>('http://localhost', {fetch: app.request});

beforeAll(async () => {
	await client.api.admin['db-reset'].$post({json: {reset: true}});
});

test('basic', async () => {
	const response = await client.api.user.register.$post(
		{
			json: {
				type: 'register',
				domain: 'test.com',
				signature: '0x0000000000000000000000000000000000000000000000000000000000000000',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			},
		},
		{
			headers: {
				SIGNATURE: `FAKE:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
			},
		},
	);
	expect(response.ok).toBeTruthy();

	const sendResponse = await client.api.private.sendMessage.$post(
		{
			json: {
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				message: 'hello world',
				messageType: 'clear',
				signature: '0x0000000000000000000000000000000000000000000000000000000000000000',
			},
		},
		{
			headers: {
				SIGNATURE: `FAKE:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
			},
		},
	);

	expect(sendResponse.ok).toBeTruthy();
});
