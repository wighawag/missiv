import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { activeStore, type StoreError } from '$lib/utils/lifecycle.js';
import { signRequest } from 'delegated-identity';
import { serverOriginOf, type ClientMessageType, type ServerMessageType } from '@missiv/common';
import { toPrivateKey } from '$lib/API.js';

/**
 * A room message. Rooms are unencrypted and relayed by the server, which
 * attributes each message to the session that sent it (`from`): no per-message
 * signature. A message of ours is `pending` until the room echoes it, or
 * `failed` with the room's error.
 */
export type ChatMessage = {
	from: string;
	message: string;
	timestamp?: number;
	pending?: boolean;
	failed?: StoreError;
};
/** A session in the room; one account may have several (tabs, devices). */
export type ChatUser = { address: string; id: string };

type Connected = { messages: ChatMessage[]; users: ChatUser[] };

export type Room = {
	// the last error, in any step: a disconnection, a refused login, a refused message
	error?: StoreError;
} & (
	| // connecting (or reconnecting) the socket
	{
			step: 'Connecting';
			address: string | undefined;
	  }
	// connected with no registered account: messages can be read, not sent
	| ({ step: 'Connected'; address: undefined; loginStatus: 'NoAccount' } & Connected)
	// connected, not logged in; `session` once the room sent its challenge
	| ({
			step: 'Connected';
			address: string;
			loginStatus: 'LoggedOut';
			session?: { id: string; challenge: string };
			loggingIn?: boolean;
	  } & Connected)
	// logged in: messages sent are the account's
	| ({
			step: 'Connected';
			address: string;
			loginStatus: 'LoggedIn';
			session: { id: string; challenge: string };
			loggingOut?: boolean;
	  } & Connected)
);

/** What `openRoom` needs of a WebSocket: the browser's, or a test's. */
export type RoomSocket = {
	send(data: string): void;
	close(): void;
	addEventListener(type: 'open' | 'close' | 'message', listener: (event: any) => void): void;
	removeEventListener(type: 'open' | 'close' | 'message', listener: (event: any) => void): void;
};

const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * A room: one socket while subscribed, for the registration's current account
 * (another account gets a new socket, so a fresh challenge). A lost socket is
 * reconnected, with a fresh challenge and a new login; every error the room
 * sends is shown.
 */
export function openRoom(params: {
	url: string;
	registration: MissivRegistrationStore;
	autoLogin?: boolean;
	/** how a socket is made (default: `new WebSocket(url)`) */
	createWebSocket?: (url: string) => RoomSocket;
	/** the first reconnection delay, doubled each failure up to 30 s (default 1 s) */
	reconnectDelayMs?: number;
}) {
	const createWebSocket =
		params.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as RoomSocket);
	const baseDelay = params.reconnectDelayMs ?? 1000;

	/** the current run's actions, while subscribed */
	let current:
		| {
				login(): Promise<void>;
				logout(): void;
				send(message: string): void;
				forceClose(): void;
		  }
		| undefined;

	const store = activeStore<MissivRegistration, Room>({
		source: params.registration,
		key: (registration) => (registration.step === 'Registered' ? registration.address : ''),
		initial: { step: 'Connecting', address: undefined },
		run(registration, ctx) {
			const account =
				registration.step === 'Registered'
					? {
							address: registration.address,
							privateKey: registration.keySet.signing.privateKey
						}
					: undefined;
			const address = account?.address;
			let websocket: RoomSocket | undefined;
			let session: { id: string; challenge: string } | undefined;
			let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
			let failures = 0;

			const withoutSession = (users: ChatUser[], id: string) => users.filter((u) => u.id !== id);

			function onOpen() {
				failures = 0;
				ctx.set(
					address
						? { step: 'Connected', loginStatus: 'LoggedOut', address, messages: [], users: [] }
						: {
								step: 'Connected',
								loginStatus: 'NoAccount',
								address: undefined,
								messages: [],
								users: []
							}
				);
			}

			function onClose() {
				detach();
				if (!ctx.active) return;
				ctx.set({ step: 'Connecting', address, error: { message: 'disconnected' } });
				const delay = Math.min(baseDelay * 2 ** failures, MAX_RECONNECT_DELAY_MS);
				failures++;
				reconnectTimer = setTimeout(connect, delay);
			}

			function onMessage(event: { data: string }) {
				let msg: ServerMessageType;
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}
				const room = ctx.get();
				if (room.step !== 'Connected') return;
				if ('challenge' in msg) {
					session = { challenge: msg.challenge, id: msg.id };
					if (room.loginStatus === 'LoggedOut') {
						ctx.set({ ...room, session, loggingIn: false });
						if (params.autoLogin) login().catch(() => {});
					}
				} else if ('message' in msg) {
					const messages = [...room.messages];
					// the room relays one socket's messages in order: our oldest pending one with this text is this
					const index =
						msg.from === address
							? messages.findIndex(
									(m) => m.pending && m.from === address && m.message === msg.message
								)
							: -1;
					const received: ChatMessage = {
						from: msg.from,
						message: msg.message,
						timestamp: msg.timestamp
					};
					if (index >= 0) {
						messages.splice(index, 1);
					}
					// pending messages stay last
					const firstPending = messages.findIndex((m) => m.pending);
					messages.splice(firstPending >= 0 ? firstPending : messages.length, 0, received);
					ctx.set({ ...room, messages });
				} else if ('joined' in msg) {
					const users = [
						...withoutSession(room.users, msg.id),
						{ address: msg.joined, id: msg.id }
					];
					if (
						room.loginStatus === 'LoggedOut' &&
						session &&
						msg.id === session.id &&
						msg.joined === address
					) {
						ctx.set({
							...room,
							loginStatus: 'LoggedIn',
							address,
							session,
							users,
							error: undefined
						});
					} else {
						ctx.set({ ...room, users });
					}
				} else if ('quit' in msg) {
					const users = withoutSession(room.users, msg.id);
					if (room.loginStatus === 'LoggedIn' && msg.id === room.session.id) {
						ctx.set({
							...room,
							loginStatus: 'LoggedOut',
							session: room.session,
							users,
							loggingIn: false
						});
					} else {
						ctx.set({ ...room, users });
					}
				} else if ('error' in msg) {
					const error: StoreError = { message: msg.error, code: msg.code };
					if (room.loginStatus === 'LoggedOut' && room.loggingIn) {
						// the login was refused
						ctx.set({ ...room, loggingIn: false, error });
						return;
					}
					// a refused message: our oldest pending one
					const messages = [...room.messages];
					const index = messages.findIndex((m) => m.pending);
					if (index >= 0) {
						messages[index] = { ...messages[index], pending: false, failed: error };
					}
					ctx.set({ ...room, messages, error });
				}
			}

			function detach() {
				if (!websocket) return;
				websocket.removeEventListener('open', onOpen);
				websocket.removeEventListener('close', onClose);
				websocket.removeEventListener('message', onMessage);
				websocket = undefined;
				session = undefined;
			}

			function connect() {
				reconnectTimer = undefined;
				if (!ctx.active) return;
				ctx.set({ step: 'Connecting', address, error: ctx.get().error });
				const ws = createWebSocket(params.url);
				websocket = ws;
				ws.addEventListener('open', onOpen);
				ws.addEventListener('close', onClose);
				ws.addEventListener('message', onMessage);
			}

			async function login() {
				const room = ctx.get();
				if (
					!account ||
					!websocket ||
					room.step !== 'Connected' ||
					room.loginStatus !== 'LoggedOut'
				) {
					throw new Error(`not logged out`);
				}
				if (!session) {
					throw new Error(`no challenge to sign yet`);
				}
				const ws = websocket;
				const challenge = session;
				ctx.set({ ...room, loggingIn: true, session: challenge });
				// the login is an Ed25519 request signature (the key set's signing key) over this
				// socket's challenge: this server, this room, now
				const signature = await signRequest(
					{
						serverOrigin: serverOriginOf(params.url),
						method: 'GET',
						path: new URL(params.url).pathname,
						body: challenge.challenge
					},
					toPrivateKey(account.privateKey)
				);
				if (ws !== websocket || !ctx.active) return;
				const msg: ClientMessageType = { address: account.address, signature };
				ws.send(JSON.stringify(msg));
			}

			function logout() {
				const room = ctx.get();
				if (!websocket || room.step !== 'Connected' || room.loginStatus !== 'LoggedIn') {
					throw new Error(`not logged in`);
				}
				ctx.set({ ...room, loggingOut: true });
				const msg: ClientMessageType = { logout: true };
				websocket.send(JSON.stringify(msg));
			}

			function send(message: string) {
				const room = ctx.get();
				if (
					!account ||
					!websocket ||
					room.step !== 'Connected' ||
					room.loginStatus !== 'LoggedIn'
				) {
					throw new Error(`not logged in`);
				}
				ctx.set({
					...room,
					error: undefined,
					messages: [...room.messages, { from: account.address, message, pending: true }]
				});
				const msg: ClientMessageType = { message };
				websocket.send(JSON.stringify(msg));
			}

			const run = {
				login,
				logout,
				send,
				forceClose: () => websocket?.close()
			};
			current = run;
			connect();
			return () => {
				if (reconnectTimer) clearTimeout(reconnectTimer);
				const ws = websocket;
				detach();
				ws?.close();
				if (current === run) current = undefined;
			};
		}
	});

	function requireRun() {
		if (!current) {
			throw new Error(`the room has no subscriber`);
		}
		return current;
	}

	return {
		subscribe: store.subscribe,
		/** send a message; it is `pending` until the room echoes it, `failed` with the room's error otherwise */
		async sendMessage(message: string) {
			requireRun().send(message);
		},
		login: () => requireRun().login(),
		logout: () => requireRun().logout(),
		/** close the socket as a network failure would (the room reconnects) */
		debug_forceClose: () => current?.forceClose()
	};
}

export type RoomStore = ReturnType<typeof openRoom>;
