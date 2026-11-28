// The live inbox channel (ADR-0006 "Live channel"), client side: ONE channel
// per (endpoint, domain, signing key), shared by every store of that account
// (the conversation list, each open conversation), open while one of them
// listens. The server's new messages and inbox rows reach it on one of two
// transports (`@missiv/common`'s inbox.ts):
// - the SOCKET (`GET /api/inbox/ws`): the server pushes them; after each
//   (re)connection a store sends a `sync` with the last seq it holds, so
//   nothing pushed while it was away is lost. A heartbeat (`ping` every 30 s,
//   `@missiv/common`'s heartbeat.ts) notices a socket that died idle: one with
//   no answer within 10 s is given up and replaced.
// - POLLING (`POST /api/inbox/changes`): every interval the channel asks for
//   the inbox rows changed after the highest inbox version it saw (on either
//   transport), and reads the messages of each changed row it lacks with
//   `listMessages {after}`; a store's `sync` is a `listMessages {after}` too.
// A store sees the same `onOpen` / `onMessage` / `onConversation` whatever the
// transport, and syncs on every `onOpen`, a switch of transport included.
//
// Decisions recorded here:
// - `transport: 'auto'` (the default) starts on the socket and moves to
//   polling after `socketFailuresBeforePolling` (3) sockets in a row failed: a
//   socket refused or lost before the server sent it anything (a frame from
//   the server proves the transport works, and resets the count, but not the
//   `welcome`, which every accepted socket is sent at once; a
//   `session-expired` close is no failure). While polling it tries a socket
//   again every `socketRetryIntervalMs` (60 s); one that opens takes over. A
//   poll refused 404 (a server without polling) sends `auto` back to the
//   socket at once. With `socket` or `poll` the channel never switches.
// - A poll from version 0 (every row: the channel saw no version yet) only
//   learns the rows, unless an earlier poll found the inbox empty: it reads no
//   message, as a new socket is pushed none of the past, and the stores fetch
//   and sync what they show on `onOpen`, which follows it. After that, a changed row's messages are read from the highest
//   seq the channel knows for it (a store's sync, a message it passed on, the
//   row's previous `lastSeq`), so a conversation no store opened still gets
//   its new messages, as on the socket.
// - A failed poll is retried with the reconnection's backoff (1 s doubling to
//   30 s), and the channel reports itself not connected until a poll succeeds,
//   which is a new `onOpen`.
// - A sync by polling hands each conversation's newest row the channel saw
//   (from either transport) to the listeners, as a socket's sync answers the
//   row, so a store that joins a polling channel later still gets the row's
//   state (its read receipt) without a poll that changes anything.
// - `features` is what the current socket's `welcome` named (the optional
//   client frames its server accepts), and undefined while none is known: no
//   socket, polling, before the welcome, or a server older than the welcome. A
//   caller sends an optional frame only when `features` names it.
import {
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_PONG,
	HEARTBEAT_TIMEOUT_REASON,
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_WS_PATH,
	INBOX_WS_PROTOCOL,
	MAX_PAGE_SIZE,
	inboxConversationKey,
	parseInboxConversationKey,
	type Conversation,
	type InboxServerFrame,
	type Message
} from '@missiv/common';
import { MissivAPIError, type API, type APIOptions } from '$lib/API.js';
import { FIRST_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS } from '$lib/utils/lifecycle.js';
import { startHeartbeat, type Heartbeat } from '$lib/utils/heartbeat.js';

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

/** How the channel reaches the server: the socket, polling, or the socket with polling as its fallback. */
export type InboxTransportOption = 'socket' | 'poll' | 'auto';

/** The default interval of the polling transport. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** How often `auto`, while polling, tries a socket again. */
export const DEFAULT_SOCKET_RETRY_INTERVAL_MS = 60_000;
/** How many sockets in a row must fail before `auto` polls. */
export const DEFAULT_SOCKET_FAILURES_BEFORE_POLLING = 3;

export type InboxListener = {
	/**
	 * the channel is open: on the first connection, after every reconnection and
	 * on every switch of transport (called at once for a listener that joins an
	 * open channel). The place to `sync` what this listener holds.
	 */
	onOpen?(): void;
	/** a message the account can see (pushed, polled, or a sync's answer); may repeat, in any order */
	onMessage?(message: Message): void;
	/** one of the account's inbox rows after a change; may repeat, in any order */
	onConversation?(conversation: Conversation): void;
	/** the channel could not open, or lost its transport; it reconnects on its own */
	onError?(error: unknown): void;
};

export type InboxChannel = {
	/** listen; the channel opens with its first listener and closes with its last */
	subscribe(listener: InboxListener): () => void;
	/**
	 * ask for the messages after `since` (by `inboxConversationKey`): resolves
	 * once the server answered (the socket's `ready`, or the polled reads), or at
	 * once when the channel is not open, since every listener syncs again on the
	 * next `onOpen`
	 */
	sync(since: Record<string, number>): Promise<void>;
	readonly connected: boolean;
	/** the transport in use: `socket` or `poll` */
	readonly transport: 'socket' | 'poll';
	/**
	 * the optional client frames the current socket's server accepts (its
	 * `welcome`), or undefined while none is known (polling, no socket yet, or a
	 * server that sends no welcome)
	 */
	readonly features: readonly string[] | undefined;
};

const channels = new Map<string, InboxChannel>();

function keyOf(endpoint: string, domain: string, privateKey: APIOptions['privateKey']) {
	const key =
		typeof privateKey === 'string' ? privateKey.toLowerCase() : Array.from(privateKey).join(',');
	return `${endpoint}\n${domain}\n${key}`;
}

/**
 * The live channel of an account in a domain: the one already open for it, or
 * a new one. `transport` is `auto` by default (see the decisions above);
 * `pollIntervalMs` (default 5 s) is the polling interval. Its socket's token is
 * a session token from `api` (renewed when the server closes the socket as
 * `session-expired`, or refused it); a lost socket is reconnected after a
 * delay that doubles from `reconnectDelayMs` (default 1 s) up to 30 s, an
 * expired session's at once. An open socket sends a `ping` every
 * `heartbeatIntervalMs` (default 30 s); when no frame arrives within
 * `heartbeatTimeoutMs` (default 10 s) of one, the socket is given up (closed
 * `heartbeat-timeout`) and reconnected as a lost one. A channel already open
 * for the account keeps the options it was opened with.
 */
export function openInboxChannel(params: {
	endpoint: string;
	domain: string;
	privateKey: APIOptions['privateKey'];
	api: API;
	createWebSocket?: CreateInboxSocket;
	reconnectDelayMs?: number;
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
	transport?: InboxTransportOption;
	pollIntervalMs?: number;
	socketRetryIntervalMs?: number;
	socketFailuresBeforePolling?: number;
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
	const option = params.transport ?? 'auto';
	const pollInterval = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const socketRetryInterval = params.socketRetryIntervalMs ?? DEFAULT_SOCKET_RETRY_INTERVAL_MS;
	const failuresBeforePolling =
		params.socketFailuresBeforePolling ?? DEFAULT_SOCKET_FAILURES_BEFORE_POLLING;
	const as = { privateKey: params.privateKey };

	const listeners = new Set<InboxListener>();
	let mode: 'socket' | 'poll' = option === 'poll' ? 'poll' : 'socket';
	let socket: InboxSocket | undefined;
	let connected = false;
	let running = false;
	/** each start is a new run: what an older run left in flight does nothing */
	let run = 0;
	let renew = false;
	let delay = firstDelay;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: Heartbeat | undefined;
	/** the syncs sent on the socket and not yet answered, in order: each `ready` answers the oldest */
	let pending: Array<() => void> = [];
	/** what the current socket's `welcome` named; undefined while none is known */
	let features: readonly string[] | undefined;
	/** the sockets in a row that failed before the server sent them anything */
	let socketFailures = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let pollDelay = firstDelay;
	let probeTimer: ReturnType<typeof setTimeout> | undefined;
	/** the highest inbox version seen, on either transport: where the next poll starts */
	let version = 0;
	/** a poll answered the inbox unchanged at version 0: empty, so every row it lists later is new */
	let knownEmpty = false;
	/** a first look at the inbox (a drain from version 0) began and has not reached its last page */
	let looking = false;
	/** per conversation (`inboxConversationKey`), the highest seq known to be held: synced, passed on, or its row's */
	const held = new Map<string, number>();
	/** per conversation, its newest row seen (by version), so a sync by polling can hand it to a store that joined later */
	const rows = new Map<string, Conversation>();

	const each = (f: (listener: InboxListener) => void) => {
		for (const listener of [...listeners]) {
			try {
				f(listener);
			} catch (err) {
				console.error(err);
			}
		}
	};

	const hold = (conversation: string, seq: number) =>
		held.set(conversation, Math.max(held.get(conversation) ?? 0, seq));

	function message(message: Message) {
		hold(inboxConversationKey(message), message.seq);
		each((l) => l.onMessage?.(message));
	}

	function row(conversation: Conversation) {
		if (typeof conversation.version === 'number' && conversation.version > version) {
			version = conversation.version;
		}
		const key = inboxConversationKey(conversation);
		const known = rows.get(key);
		if (!known || (conversation.version ?? 0) >= (known.version ?? 0)) {
			rows.set(key, conversation);
		}
		each((l) => l.onConversation?.(conversation));
	}

	function opened() {
		connected = true;
		each((l) => l.onOpen?.());
	}

	function settlePending() {
		const settled = pending;
		pending = [];
		for (const resolve of settled) resolve();
	}

	// ----------------------------------------------------------------------------------------------
	// the socket
	// ----------------------------------------------------------------------------------------------

	function scheduleReconnect(after: number) {
		if (!running) return;
		reconnectTimer = setTimeout(connect, after);
	}

	/** open a socket: the transport in use, or (while polling) a try at going back to it */
	async function connect() {
		reconnectTimer = undefined;
		probeTimer = undefined;
		if (!running) return;
		const current = run;
		let token: string;
		try {
			token = (await params.api.getSession(params.domain, as, { renew: renew })).token;
			renew = false;
		} catch (err) {
			if (!running || current !== run) return;
			if (mode === 'poll') {
				scheduleProbe();
				return;
			}
			each((l) => l.onError?.(err));
			scheduleReconnect(delay);
			delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
			return;
		}
		if (!running || current !== run) return;
		const ws = createWebSocket(url, [INBOX_WS_PROTOCOL, token]);
		socket = ws;
		let wasOpen = false;
		ws.addEventListener('open', () => {
			if (socket !== ws) return;
			wasOpen = true;
			delay = firstDelay;
			if (mode === 'poll') {
				// back on the socket: polling stops
				stopPolling();
				mode = 'socket';
			}
			heartbeat = startHeartbeat({
				send: (data) => ws.send(data),
				onTimeout: () => {
					if (socket !== ws) return;
					ws.close(HEARTBEAT_CLOSE_TIMEOUT, HEARTBEAT_TIMEOUT_REASON);
					// its close event may come much later (a dead network): lost now
					lost(ws, HEARTBEAT_CLOSE_TIMEOUT, true);
				},
				intervalMs: params.heartbeatIntervalMs,
				timeoutMs: params.heartbeatTimeoutMs
			});
			opened();
		});
		ws.addEventListener('message', (event: { data: unknown }) => {
			if (socket !== ws) return;
			heartbeat?.received();
			if (event.data === HEARTBEAT_PONG) {
				// the server answered: this transport works
				socketFailures = 0;
				return;
			}
			let frame: InboxServerFrame;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			// the server answered: this transport works. Not the welcome, which every
			// accepted socket gets at once, so a socket dropped right after it still
			// counts toward falling back to polling.
			if (frame.type !== 'welcome') socketFailures = 0;
			if (frame.type === 'welcome') {
				features = Array.isArray(frame.features)
					? frame.features.filter((name): name is string => typeof name === 'string')
					: [];
			} else if (frame.type === 'ready') {
				pending.shift()?.();
			} else if (frame.type === 'message') {
				message(frame.message);
			} else if (frame.type === 'conversation') {
				row(frame.conversation);
			}
		});
		ws.addEventListener('close', (event: { code?: number }) => {
			lost(ws, event.code, wasOpen);
		});
	}

	/** the socket `ws` closed (or was given up): reconnect, or poll */
	function lost(ws: InboxSocket, code: number | undefined, wasOpen: boolean) {
		if (socket !== ws) return;
		socket = undefined;
		features = undefined;
		heartbeat?.stop();
		heartbeat = undefined;
		if (!wasOpen) renew = true;
		if (mode === 'poll') {
			// a try at going back to the socket that failed: polling goes on
			scheduleProbe();
			return;
		}
		connected = false;
		settlePending();
		if (!running) return;
		if (code === INBOX_CLOSE_SESSION_EXPIRED) {
			// the token ran out: a new one, and back at once
			renew = true;
			scheduleReconnect(0);
			return;
		}
		// refused before it opened: the token may be stale (a rotated secret, a
		// replaced key set), so the next attempt opens a new session
		socketFailures++;
		each((l) =>
			l.onError?.(
				new Error(
					!wasOpen
						? 'the live inbox refused the connection'
						: code === HEARTBEAT_CLOSE_TIMEOUT
							? 'the live inbox stopped answering'
							: 'the live inbox disconnected'
				)
			)
		);
		if (option === 'auto' && socketFailures >= failuresBeforePolling) {
			startPolling();
			return;
		}
		scheduleReconnect(delay);
		delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
	}

	function scheduleProbe() {
		if (!running || option !== 'auto' || mode !== 'poll' || probeTimer) return;
		probeTimer = setTimeout(connect, socketRetryInterval);
	}

	// ----------------------------------------------------------------------------------------------
	// polling
	// ----------------------------------------------------------------------------------------------

	function startPolling() {
		mode = 'poll';
		pollDelay = firstDelay;
		stopPolling();
		pollTimer = setTimeout(poll, 0);
		scheduleProbe();
	}

	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		if (probeTimer) clearTimeout(probeTimer);
		probeTimer = undefined;
	}

	/** the messages of `conversation` after `after`, page by page, passed on */
	async function readAfter(conversation: string, after: number, current: number) {
		const parsed = parseInboxConversationKey(conversation);
		if (!parsed) return;
		for (;;) {
			const page = await params.api.listMessages(
				{ type: 'listMessages', domain: params.domain, ...parsed, after, limit: MAX_PAGE_SIZE },
				as
			);
			if (!running || current !== run) return;
			for (const m of page.messages) {
				message(m);
				after = Math.max(after, m.seq);
			}
			if (!page.hasMore || page.messages.length === 0) return;
		}
	}

	/** poll until the inbox is unchanged: each changed row passed on, and the messages it has that are not held */
	async function drain(current: number) {
		// the first look at the inbox learns its rows, reading no message (see the decisions): it spans every
		// page (the later ones start above version 0), and one cut short (an error, the channel stopped) is
		// resumed as a first look by the next drain, of this run or a later one, so no page of it is read as a
		// change; a drain of a stopped run writes no state
		const firstLook = looking || (version === 0 && !knownEmpty);
		if (firstLook) looking = true;
		for (;;) {
			const answer = await params.api.inboxChanges(
				{ type: 'inboxChanges', domain: params.domain, since: version },
				as
			);
			if (!running || current !== run) return;
			if ('unchanged' in answer) {
				version = answer.version;
				if (version === 0) knownEmpty = true;
				looking = false;
				return;
			}
			for (const conversation of answer.conversations) {
				const name = inboxConversationKey(conversation);
				const known = held.get(name);
				row(conversation);
				if (!firstLook && conversation.lastSeq > (known ?? 0)) {
					await readAfter(name, known ?? 0, current);
					if (!running || current !== run) return;
				}
				hold(name, conversation.lastSeq);
			}
			version = answer.version;
			if (!answer.hasMore) {
				looking = false;
				return;
			}
		}
	}

	async function poll() {
		pollTimer = undefined;
		if (!running || mode !== 'poll') return;
		const current = run;
		try {
			await drain(current);
		} catch (err) {
			if (!running || current !== run || mode !== 'poll') return;
			connected = false;
			each((l) => l.onError?.(err));
			if (option === 'auto' && err instanceof MissivAPIError && err.status === 404) {
				// this server does not poll: the socket, from the start
				stopPolling();
				mode = 'socket';
				socketFailures = 0;
				delay = firstDelay;
				scheduleReconnect(0);
				return;
			}
			pollTimer = setTimeout(poll, pollDelay);
			pollDelay = Math.min(pollDelay * 2, MAX_RETRY_DELAY_MS);
			return;
		}
		if (!running || current !== run || mode !== 'poll') return;
		pollDelay = firstDelay;
		if (!connected) opened();
		if (mode === 'poll' && !pollTimer) pollTimer = setTimeout(poll, pollInterval);
	}

	/** a store's sync while polling: the messages after each seq, over HTTP */
	async function syncByPolling(since: Record<string, number>) {
		const current = run;
		await Promise.all(
			Object.entries(since).map(async ([conversation, seq]) => {
				hold(conversation, seq);
				// the row, as a socket's sync answers it: the newest this channel saw
				const known = rows.get(conversation);
				if (known) each((l) => l.onConversation?.(known));
				try {
					await readAfter(conversation, seq, current);
				} catch (err) {
					// the next poll, or the next `onOpen`, catches up
					console.error(`the live inbox could not read a conversation`, err);
				}
			})
		);
	}

	// ----------------------------------------------------------------------------------------------

	function start() {
		running = true;
		run++;
		delay = firstDelay;
		socketFailures = 0;
		if (option === 'poll') {
			startPolling();
		} else {
			mode = 'socket';
			connect();
		}
	}

	function stop() {
		running = false;
		run++;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
		stopPolling();
		const ws = socket;
		socket = undefined;
		features = undefined;
		connected = false;
		heartbeat?.stop();
		heartbeat = undefined;
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
			if (!connected || Object.keys(since).length === 0) {
				return Promise.resolve();
			}
			if (mode === 'poll') {
				return syncByPolling(since);
			}
			if (!socket) return Promise.resolve();
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
		},
		get transport() {
			return mode;
		},
		get features() {
			return features;
		}
	};
	channels.set(key, channel);
	return channel;
}
