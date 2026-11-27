// Rooms over a WebSocket, unchanged since 0.5 (spec `scalable-rooms` will change
// them): a socket logged in by the user's Ed25519 request signature over the
// socket's challenge, then room messages attributed by the server to it.
import {serverOriginOf, type ServerMessageType} from '@missiv/common';
import {signRequest} from 'delegated-identity';
import WebSocket from 'ws';
import type {TestUser} from '../../../client-server/test/setup.js';
import type {LoadUser, RoomConnection, Target} from './types.js';

export async function joinRoom(
	target: Target,
	user: LoadUser & TestUser,
	room: string,
	options?: {localAddress?: string},
): Promise<RoomConnection> {
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
