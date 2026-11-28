// The nodejs platform's app, built as the CLI builds it and exercised through
// app.request, and once served on a loopback port for the live inbox channel's
// real WebSocket. Rooms need a real socket, so here only their route's refusals
// are checked; the Room itself is tested in test/client-server.
import {describe, it, expect} from 'vitest';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {deriveKeySet, originPublicKeyPublicationMessage} from 'delegated-identity';
import {API, composeMessage} from '@missiv/client';
import {conversationIDOf, INBOX_WS_PATH, INBOX_WS_PROTOCOL, type InboxServerFrame} from '@missiv/common';
import {serve} from '@hono/node-server';
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

	it("serves the live inbox channel: a message sent by one member reaches the other's open socket", async () => {
		const {app, injectWebSocket} = await createNodeServer({
			db: ':memory:',
			env: {SESSION_SECRET: 'test-session-secret'},
		});
		const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
			const s = serve({fetch: app.fetch, port: 0, hostname: '127.0.0.1'}, () => resolve(s));
		});
		injectWebSocket(server);
		try {
			const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
			const api = new API(url);
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
			const {token} = await api.getSession(DOMAIN, {privateKey: b.keySet.signing.privateKey});
			const ws = new WebSocket(url.replace(/^http/, 'ws') + INBOX_WS_PATH, [INBOX_WS_PROTOCOL, token]);
			const frames: InboxServerFrame[] = [];
			const received = new Promise<InboxServerFrame>((resolve) =>
				ws.addEventListener('message', (event) => {
					const frame = JSON.parse(String(event.data)) as InboxServerFrame;
					frames.push(frame);
					if (frame.type === 'message') resolve(frame);
				}),
			);
			await new Promise((resolve, reject) => {
				ws.addEventListener('open', resolve);
				ws.addEventListener('error', reject);
			});
			const message = await composeMessage({
				destination: {domain: DOMAIN, namespace: ''},
				sender: {address: a.address, keySet: a.keySet},
				recipient: {address: b.address, keySet: b.keySet},
				text: 'live',
			});
			await api.sendMessage({type: 'sendMessage', message}, {privateKey: a.keySet.signing.privateKey});
			const frame = await received;
			expect(frame.type === 'message' && [frame.message.seq, frame.message.content]).toEqual([1, message.content]);
			// every socket is sent the welcome first
			expect(frames[0]).toEqual({type: 'welcome', features: []});
			ws.close();
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
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
