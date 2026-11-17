// The nodejs platform's app, built as the CLI builds it and exercised through
// app.request: no port is opened. Rooms need a real socket, so here only their
// route's refusals are checked; the Room itself is tested in test/client-server.
import {describe, it, expect} from 'vitest';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {delegatePublicKey, originPublicKeyPublicationMessage} from 'delegated-identity';
import {API, clearCopies} from 'missiv-client';
import {conversationIDOf} from 'missiv-common';
import {createNodeServer} from '../src/index.js';

const DOMAIN = 'test.com';
const APP_ORIGIN = 'https://test.com';

async function createUser() {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const delegatePrivateKey = generatePrivateKey();
	const publicKey = delegatePublicKey(delegatePrivateKey);
	return {
		address: wallet.address.toLowerCase() as `0x${string}`,
		delegatePrivateKey,
		signature: await wallet.signMessage({message: originPublicKeyPublicationMessage(APP_ORIGIN, publicKey)}),
	};
}

describe('nodejs platform', () => {
	it('builds its app on a fresh database and serves the HTTP API', async () => {
		const {app} = await createNodeServer({db: ':memory:', env: {}});
		const api = new API('http://localhost', {fetch: app.request as any});
		const [a, b] = await Promise.all([createUser(), createUser()]);
		for (const user of [a, b]) {
			await api.register(
				{type: 'register', domain: DOMAIN, appOrigin: APP_ORIGIN, address: user.address, signature: user.signature},
				{privateKey: user.delegatePrivateKey},
			);
		}
		const conversationID = conversationIDOf([a.address, b.address]);
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: DOMAIN,
				namespace: '',
				conversationID,
				lastMessageReadTimestampMS: 0,
				messageType: 'clear',
				messages: await clearCopies({
					scope: {domain: DOMAIN, namespace: '', conversationID},
					sender: {address: a.address, privateKey: a.delegatePrivateKey},
					recipients: [b.address],
					text: 'hello',
				}),
			},
			{privateKey: a.delegatePrivateKey},
		);
		const {messages} = await api.getMessages(
			{type: 'getMessages', domain: DOMAIN, namespace: '', conversationID},
			{privateKey: b.delegatePrivateKey},
		);
		expect(messages.map((m) => m.content)).toEqual(['hello']);
	});

	it('refuses a room name that does not start with @', async () => {
		const {app} = await createNodeServer({db: ':memory:', env: {}});
		const response = await app.request('http://localhost/api/public/room/test.com/ws', {
			headers: {upgrade: 'websocket'},
		});
		expect(response.status).toBe(400);
	});

	it('refuses the admin API when ADMIN_TOKEN is unset', async () => {
		const {app} = await createNodeServer({db: ':memory:', env: {}});
		const response = await app.request('http://localhost/api/admin/db-reset', {
			method: 'POST',
			headers: {'content-type': 'application/json', Authorization: 'Bearer anything'},
			body: JSON.stringify({reset: true}),
		});
		expect(response.status).toBe(403);
	});
});
