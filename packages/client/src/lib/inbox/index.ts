// The live inbox channel (ADR-0006 "Live channel"), client side: ONE WebSocket
// per (endpoint, domain, signing key), shared by every store of that account
// (the conversation list, each open conversation), open while one of them
// listens. The server pushes the account's new messages and inbox rows on it;
// after each (re)connection a store sends a `sync` with the last seq it holds,
// so nothing pushed while it was away is lost. No store polls.
import {
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_WS_PATH,
	INBOX_WS_PROTOCOL,
	type Conversation,
	type InboxServerFrame,
	type Message
} from '@missiv/common';
import type { API, APIOptions } from '$lib/API.js';
import { FIRST_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS } from '$lib/utils/lifecycle.js';

/** What the channel needs of a WebSocket: the browser's, or a test's. */
export type InboxSocket = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: 'open' | 'close' | 'message' | 'error',
		listener: (event: any) => void
	): void;
};

/** How the channel makes a socket (default: `new WebSocket(url, protocols)`). */
export type CreateInboxSocket = (url: string, protocols: string[]) => InboxSocket;

export type InboxListener = {
	/**
	 * the socket is open: on the first connection and after every reconnection
	 * (called at once for a listener that joins an open channel). The place to
	 * `sync` what this listener holds.
	 */
	onOpen?(): void;
	/** a message the account can see (pushed, or a sync's answer); may repeat, in any order */
	onMessage?(message: Message): void;
	/** one of the account's inbox rows after a change; may repeat, in any order */
	onConversation?(conversation: Conversation): void;
	/** the channel could not open, or lost its socket; it reconnects on its own */
	onError?(error: unknown): void;
};

export type InboxChannel = {
	/** listen; the channel opens with its first listener and closes with its last */
	subscribe(listener: InboxListener): () => void;
	/**
	 * ask for the messages after `since` (by `inboxConversationKey`): resolves
	 * once the server answered (its `ready`), or at once when the socket is not
	 * open, since every listener syncs again on the next `onOpen`
	 */
	sync(since: Record<string, number>): Promise<void>;
	readonly connected: boolean;
};

const channels = new Map<string, InboxChannel>();

function keyOf(endpoint: string, domain: string, privateKey: APIOptions['privateKey']) {
	const key =
		typeof privateKey === 'string' ? privateKey.toLowerCase() : Array.from(privateKey).join(',');
	return `${endpoint}\n${domain}\n${key}`;
}

/**
 * The live channel of an account in a domain: the one already open for it, or
 * a new one. Its token is a session token from `api` (renewed when the server
 * closes the socket as `session-expired`, or refused it); a lost socket is
 * reconnected after a delay that doubles from `reconnectDelayMs` (default 1 s)
 * up to 30 s, an expired session's at once.
 */
export function openInboxChannel(params: {
	endpoint: string;
	domain: string;
	privateKey: APIOptions['privateKey'];
	api: API;
	createWebSocket?: CreateInboxSocket;
	reconnectDelayMs?: number;
}): InboxChannel {
	const key = keyOf(params.endpoint, params.domain, params.privateKey);
	const existing = channels.get(key);
	if (existing) {
		return existing;
	}
	const createWebSocket: CreateInboxSocket =
		params.createWebSocket ??
		((url, protocols) => new WebSocket(url, protocols) as unknown as InboxSocket);
	const url = params.endpoint.replace(/^http/, 'ws') + INBOX_WS_PATH;
	const firstDelay = params.reconnectDelayMs ?? FIRST_RETRY_DELAY_MS;

	const listeners = new Set<InboxListener>();
	let socket: InboxSocket | undefined;
	let connected = false;
	let running = false;
	let renew = false;
	let delay = firstDelay;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	/** the syncs sent and not yet answered, in order: each `ready` answers the oldest */
	let pending: Array<() => void> = [];

	const each = (f: (listener: InboxListener) => void) => {
		for (const listener of [...listeners]) {
			try {
				f(listener);
			} catch (err) {
				console.error(err);
			}
		}
	};

	function settlePending() {
		const settled = pending;
		pending = [];
		for (const resolve of settled) resolve();
	}

	function scheduleReconnect(after: number) {
		if (!running) return;
		reconnectTimer = setTimeout(connect, after);
	}

	async function connect() {
		reconnectTimer = undefined;
		if (!running) return;
		let token: string;
		try {
			token = (
				await params.api.getSession(
					params.domain,
					{ privateKey: params.privateKey },
					{ renew: renew }
				)
			).token;
			renew = false;
		} catch (err) {
			if (!running) return;
			each((l) => l.onError?.(err));
			scheduleReconnect(delay);
			delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
			return;
		}
		if (!running) return;
		const ws = createWebSocket(url, [INBOX_WS_PROTOCOL, token]);
		socket = ws;
		let opened = false;
		ws.addEventListener('open', () => {
			if (socket !== ws) return;
			opened = true;
			connected = true;
			delay = firstDelay;
			each((l) => l.onOpen?.());
		});
		ws.addEventListener('message', (event: { data: unknown }) => {
			if (socket !== ws) return;
			let frame: InboxServerFrame;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (frame.type === 'ready') {
				pending.shift()?.();
			} else if (frame.type === 'message') {
				each((l) => l.onMessage?.(frame.message));
			} else if (frame.type === 'conversation') {
				each((l) => l.onConversation?.(frame.conversation));
			}
		});
		ws.addEventListener('close', (event: { code?: number }) => {
			if (socket !== ws) return;
			socket = undefined;
			connected = false;
			settlePending();
			if (!running) return;
			if (event.code === INBOX_CLOSE_SESSION_EXPIRED) {
				// the token ran out: a new one, and back at once
				renew = true;
				scheduleReconnect(0);
				return;
			}
			// refused before it opened: the token may be stale (a rotated secret, a
			// replaced key set), so the next attempt opens a new session
			if (!opened) renew = true;
			each((l) =>
				l.onError?.(
					new Error(
						opened ? 'the live inbox disconnected' : 'the live inbox refused the connection'
					)
				)
			);
			scheduleReconnect(delay);
			delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
		});
	}

	function start() {
		running = true;
		delay = firstDelay;
		connect();
	}

	function stop() {
		running = false;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		const ws = socket;
		socket = undefined;
		connected = false;
		settlePending();
		ws?.close(1000, 'unsubscribed');
		if (channels.get(key) === channel) channels.delete(key);
	}

	const channel: InboxChannel = {
		subscribe(listener) {
			listeners.add(listener);
			if (!running) {
				channels.set(key, channel);
				start();
			} else if (connected) {
				queueMicrotask(() => {
					if (listeners.has(listener) && connected) listener.onOpen?.();
				});
			}
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size === 0) stop();
			};
		},
		sync(since) {
			if (!connected || !socket || Object.keys(since).length === 0) {
				return Promise.resolve();
			}
			const ws = socket;
			return new Promise<void>((resolve) => {
				pending.push(resolve);
				try {
					ws.send(JSON.stringify({ type: 'sync', since }));
				} catch {
					pending = pending.filter((p) => p !== resolve);
					resolve();
				}
			});
		},
		get connected() {
			return connected;
		}
	};
	channels.set(key, channel);
	return channel;
}
