// missiv 0.5's API (`@missiv/server` 0.5, `@missiv/client` 0.4), on 0.6's keys
// since `messaging-keys-and-registration`: registrations and sends signed by the
// user's Ed25519 signing key (its key set's, delegated-identity), every other
// request on a session token since `sessions-and-tokens`, one signed copy per
// member, the newest page of a conversation as its read, rooms over a WebSocket
// logged in by a request signature over the socket's challenge. (The 0.5
// baseline was measured with secp256k1 keys, before that change.) Users, registration and sends
// are the client-server tests' own (`test/client-server/test/setup.ts`), over
// real HTTP instead of `app.request`.
import {API} from '@missiv/client';
import {conversationIDOf, serverOriginOf, type ServerMessageType} from '@missiv/common';
import {signRequest} from 'delegated-identity';
import WebSocket from 'ws';
import {createActions, createUser, DOMAIN, NAMESPACE, type TestUser} from '../../../client-server/test/setup.js';
import type {Adapter, AdapterFactory, LoadUser, RoomConnection} from './types.js';

type User = LoadUser & TestUser;

export const v0_5: AdapterFactory = (target) => {
	const api = new API(target.url);
	const actions = createActions(api);

	function asUser(user: LoadUser): User {
		return user as User;
	}

	async function joinRoom(loadUser: LoadUser, room: string, options?: {localAddress?: string}) {
		const user = asUser(loadUser);
		const wsURL = `${target.url.replace(/^http/, 'ws')}/api/public/room/${room}/ws`;
		const ws = new WebSocket(wsURL, options?.localAddress ? {localAddress: options.localAddress} : undefined);
		const messageListeners: ((text: string, at: number) => void)[] = [];
		const errorListeners: ((code: string) => void)[] = [];

		const loggedIn = new Promise<void>((resolve, reject) => {
			ws.on('error', reject);
			ws.on('close', () => reject(new Error(`room socket closed before login`)));
			ws.on('message', async (raw) => {
				const receivedAt = performance.now();
				const msg = JSON.parse(raw.toString()) as ServerMessageType;
				if ('challenge' in msg) {
					const signature = await signRequest(
						{serverOrigin: serverOriginOf(wsURL), method: 'GET', path: new URL(wsURL).pathname, body: msg.challenge},
						user.keySet.signing.privateKey,
					);
					ws.send(JSON.stringify({address: user.address, signature}));
				} else if ('joined' in msg) {
					if (msg.joined === user.address) {
						resolve();
					}
				} else if ('error' in msg) {
					const code = (msg as {code?: string}).code || 'error';
					errorListeners.forEach((l) => l(code));
					reject(new Error(`room refused the login: ${msg.error}`));
				} else if ('message' in msg) {
					messageListeners.forEach((l) => l(msg.message, receivedAt));
				}
			});
		});
		await loggedIn;

		const connection: RoomConnection = {
			send(text) {
				ws.send(JSON.stringify({message: text, signature: '0x'}));
			},
			onMessage(listener) {
				messageListeners.push(listener);
			},
			onError(listener) {
				errorListeners.push(listener);
			},
			close() {
				return new Promise((resolve) => {
					if (ws.readyState === WebSocket.CLOSED) {
						resolve();
						return;
					}
					ws.once('close', () => resolve());
					ws.close();
				});
			},
		};
		return connection;
	}

	const adapter: Adapter = {
		name: '0.5',
		room: `@${DOMAIN}`,
		async createUser() {
			return createUser();
		},
		async register(user) {
			await actions.register(asUser(user));
		},
		async openConversation(a, b) {
			await actions.send({from: asUser(a), to: asUser(b), content: 'hello', messageType: 'encrypted'});
			const id = conversationIDOf([a.address, b.address]);
			await actions.accept(asUser(b), id);
			return {id, members: [a, b]};
		},
		async send(from, conversation, content) {
			const to = conversation.members[0] === from ? conversation.members[1] : conversation.members[0];
			await actions.send({from: asUser(from), to: asUser(to), content, messageType: 'encrypted'});
		},
		async read(user, conversation) {
			return (await actions.messages(asUser(user), conversation.id)).length;
		},
		async listConversations(user) {
			const {conversations} = await api.getConversations(
				{type: 'getConversations', domain: DOMAIN, namespace: NAMESPACE},
				{privateKey: asUser(user).keySet.signing.privateKey},
			);
			return conversations.length;
		},
		joinRoom,
	};

	return adapter;
};
