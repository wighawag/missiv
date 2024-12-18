import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {getPublicKey, utils as secpUtils} from '@noble/secp256k1';
import {publicKeyAuthorizationMessage} from 'missiv-common';
import {App, createServer} from 'missiv-server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import {API} from 'missiv-client';

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

export async function createUser() {
	const privateKey = generatePrivateKey();
	const account = privateKeyToAccount(privateKey);
	const delegatePrivateKey = secpUtils.randomPrivateKey();
	const delegatePublicKey = toHex(getPublicKey(delegatePrivateKey));
	const message = publicKeyAuthorizationMessage({
		address: account.address,
		publicKey: delegatePublicKey.toLowerCase(),
	});
	const user = {
		delegatePublicKey: delegatePublicKey.toLowerCase() as `0x${string}`,
		address: account.address.toLowerCase() as `0x${string}`,
		signatureForDelegation: (await account.signMessage({message: message})).toLowerCase() as `0x${string}`,
		delegatePrivateKey: delegatePrivateKey,
	} as const;

	return user;
}

export const USER_A = await createUser();
export const USER_B = await createUser();

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

export const api = new API('http://localhost', {fetch: app.request as any}); // TODO type instead of any

export const FAKE_SIG = '0x0000000000000000000000000000000000000000000000000000000000000000';
