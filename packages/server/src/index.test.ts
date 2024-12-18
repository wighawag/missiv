import {beforeAll, expect, test} from 'vitest';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {getPublicKey, utils as secpUtils} from '@noble/secp256k1';
import {publicKeyAuthorizationMessage} from 'missiv-common';
import {App, createServer} from '../src/index.js';
import {hc} from 'hono/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

async function createUser() {
	const userAPrivateKey = generatePrivateKey();
	const userAAccount = privateKeyToAccount(userAPrivateKey);
	const userADelegatePrivateKey = secpUtils.randomPrivateKey();
	const userADelegatePublicKey = toHex(getPublicKey(userADelegatePrivateKey));
	const userAMessage = publicKeyAuthorizationMessage({
		address: userAAccount.address,
		publicKey: userADelegatePublicKey,
	});
	return {
		publicKey: userADelegatePublicKey,
		address: userAAccount.address,
		signature: await userAAccount.signMessage({message: userAMessage}),
	} as const;
}

const userA = await createUser();
const userB = await createUser();

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
