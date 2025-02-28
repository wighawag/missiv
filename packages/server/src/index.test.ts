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
	services: {
		getDB() {
			return remoteSQL;
		},

		getRoom() {
			throw new Error(`no getRoom implemented in test`);
		},
		getRateLimiter() {
			throw new Error(`no getRateLimiter implemented in test`);
		},
	},
	getEnv() {
		return {
			DEV: 'true',
		};
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
	if (!response.ok) {
		console.error(await response.text());
	}
	expect(response.ok).toBeTruthy();

	const sendResponse = await client.api.private.sendMessage.$post(
		{
			json: {
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				conversationID: '1', // TODO: this should be a hash of the participants // but this should be handled on server
				lastMessageReadTimestampMS: 1,
				messageType: 'clear',
				messages: [
					{
						to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
						toPublicKey: '0xff', // TODO
						content: 'hello world',
						signature: '0x0000000000000000000000000000000000000000000000000000000000000000',
					},
				],
			},
		},
		{
			headers: {
				SIGNATURE: `FAKE:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
			},
		},
	);

	if (!sendResponse.ok) {
		console.error(await sendResponse.text());
	}
	expect(sendResponse.ok).toBeTruthy();
});
