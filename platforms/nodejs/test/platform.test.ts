// The nodejs platform's app, built as the CLI builds it and exercised through
// app.request: no port is opened. Rooms need a real socket, so here only their
// route's refusals are checked; the Room itself is tested in test/client-server.
import {describe, it, expect} from 'vitest';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {deriveKeySet, originPublicKeyPublicationMessage} from 'delegated-identity';
import {API, composeMessage} from '@missiv/client';
import {conversationIDOf} from '@missiv/common';
import {createNodeServer} from '../src/index.js';

const DOMAIN = 'test.com';
const APP_ORIGIN = 'https://test.com';

async function createUser() {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const keySet = deriveKeySet(generatePrivateKey());
	return {
		address: wallet.address.toLowerCase() as `0x${string}`,
		keySet,
		ownershipSignature: await wallet.signMessage({message: originPublicKeyPublicationMessage(APP_ORIGIN, keySet)}),
	};
}

describe('nodejs platform', () => {
	it('builds its app on a fresh database and serves the 0.6 messaging API', async () => {
		const {app} = await createNodeServer({db: ':memory:', env: {SESSION_SECRET: 'test-session-secret'}});
		const api = new API('http://localhost', {fetch: app.request as any});
		const [a, b] = await Promise.all([createUser(), createUser()]);
		for (const user of [a, b]) {
			await api.register(
				{
					type: 'register',
					domain: DOMAIN,
					appOrigin: APP_ORIGIN,
					address: user.address,
					keySet: {
						signing: {publicKey: user.keySet.signing.publicKey},
						encryption: {publicKey: user.keySet.encryption.publicKey},
					},
					ownershipSignature: user.ownershipSignature,
				},
				{privateKey: user.keySet.signing.privateKey},
			);
		}
		const conversationID = conversationIDOf([a.address, b.address]);
		const message = await composeMessage({
			destination: {domain: DOMAIN, namespace: ''},
			sender: {address: a.address, keySet: a.keySet},
			recipient: {address: b.address, keySet: b.keySet},
			text: 'hello',
		});
		expect(
			await api.sendMessage({type: 'sendMessage', message}, {privateKey: a.keySet.signing.privateKey}),
		).toMatchObject({seq: 1});
		const {messages} = await api.listMessages(
			{type: 'listMessages', domain: DOMAIN, namespace: '', conversationID, after: 0},
			{privateKey: b.keySet.signing.privateKey},
		);
		const {conversations} = await api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: '', status: 'unaccepted'},
			{privateKey: b.keySet.signing.privateKey},
		);
		expect(conversations.map((c) => c.lastSeq)).toEqual([1]);
		expect(messages.map((m) => [m.seq, m.content])).toEqual([[1, message.content]]);
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

	it('refuses every authenticated route when SESSION_SECRET is unset', async () => {
		const {app} = await createNodeServer({db: ':memory:', env: {}});
		const response = await app.request('http://localhost/api/session', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({domain: DOMAIN}),
		});
		expect(response.status).toBe(403);
	});
});
