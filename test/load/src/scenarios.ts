// The scenarios: what simulated clients do to the server, and what is timed.
//
// The HTTP scenarios (send, read, list) are closed loops: each client issues its
// next request as soon as the previous one is answered, so `clients` is the
// concurrency and the throughput is what the server sustains at it (the latency
// then includes the queueing). The room scenario is an open loop: messages go
// out at a fixed rate whatever the answers, and each is timed until its last
// delivery.
import {performance} from 'node:perf_hooks';
import type {Adapter, InboxConnection, LoadConversation, LoadUser, RoomConnection} from './adapters/types.js';
import {summarize, type Summary} from './stats.js';

export const SCENARIOS = ['send', 'read', 'list', 'live', 'room'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export type Parameters = {
	/** simulated users of the HTTP scenarios, each one client in the loop */
	clients: number;
	/** conversations among them (each client gets about 2 * conversations / clients) */
	conversations: number;
	/** seconds each scenario runs */
	duration: number;
	/** messages a conversation holds before `read` runs */
	history: number;
	/** characters of a direct message's content */
	size: number;
	/** sockets in the room */
	roomSize: number;
	/** room messages per second, all sockets taking turns to send */
	rate: number;
};

/**
 * The conversations of `count` pairs among `clients`: neighbours first (0-1,
 * 2-3, ..., then 1-2, 3-4, ...), then further apart, so every client is in one
 * before any is in two, and no pair repeats.
 */
export function conversationPairs(clients: number, count: number): [number, number][] {
	if (count > (clients * (clients - 1)) / 2) {
		throw new Error(`${clients} clients have only ${(clients * (clients - 1)) / 2} pairs, not ${count}`);
	}
	const pairs: [number, number][] = [];
	const seen = new Set<string>();
	for (let distance = 1; distance < clients && pairs.length < count; distance++) {
		for (let start = 0; start < 2 && pairs.length < count; start++) {
			for (let i = start; i < clients && pairs.length < count; i += 2) {
				const a = i;
				const b = (i + distance) % clients;
				const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
				if (a !== b && !seen.has(key)) {
					seen.add(key);
					pairs.push([a, b]);
				}
			}
		}
	}
	if (pairs.length < count) {
		throw new Error(`found only ${pairs.length} of ${count} pairs`);
	}
	return pairs;
}

/** Run `f` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({length: Math.min(limit, items.length)}, async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await f(items[i], i);
			}
		}),
	);
	return results;
}

function errorCode(err: unknown): string {
	const e = err as {code?: unknown; message?: unknown};
	return typeof e?.code === 'string' ? e.code : String(e?.message ?? err).slice(0, 60);
}

/** Every client in a loop for `durationMs`: the latencies of what succeeded, and the errors by code. */
async function closedLoop(
	clients: number,
	durationMs: number,
	op: (client: number, round: number) => Promise<unknown>,
) {
	const latencies: number[] = [];
	const errors: Record<string, number> = {};
	let errorCount = 0;
	const start = performance.now();
	const end = start + durationMs;
	await Promise.all(
		Array.from({length: clients}, async (_, client) => {
			for (let round = 0; performance.now() < end; round++) {
				const t = performance.now();
				try {
					await op(client, round);
					latencies.push(performance.now() - t);
				} catch (err) {
					errorCount++;
					const code = errorCode(err);
					errors[code] = (errors[code] || 0) + 1;
				}
			}
		}),
	);
	return {latencies, errors, errorCount, elapsed: performance.now() - start};
}

/** The users and conversations the HTTP scenarios share, registered and opened once. */
export type World = {users: LoadUser[]; conversations: LoadConversation[]; byUser: LoadConversation[][]};

export async function createWorld(adapter: Adapter, p: Parameters, log: (s: string) => void): Promise<World> {
	const t = performance.now();
	const users = await mapLimit(Array.from({length: p.clients}), 16, () => adapter.createUser());
	await mapLimit(users, 16, (u) => adapter.register(u));
	const conversations = await mapLimit(conversationPairs(p.clients, p.conversations), 16, ([a, b]) =>
		adapter.openConversation(users[a], users[b]),
	);
	const byUser = users.map((u) => conversations.filter((c) => c.members.includes(u)));
	log(`setup: ${users.length} users registered, ${conversations.length} conversations opened in ${ms(t)}`);
	return {users, conversations, byUser};
}

function ms(since: number) {
	return `${((performance.now() - since) / 1000).toFixed(1)} s`;
}

function content(size: number, tag: string) {
	return (tag + ':').padEnd(size, 'x');
}

export async function runSend(adapter: Adapter, world: World, p: Parameters): Promise<Summary> {
	const r = await closedLoop(world.users.length, p.duration * 1000, (client, round) => {
		const mine = world.byUser[client];
		const conversation = mine[round % mine.length];
		return adapter.send(world.users[client], conversation, content(p.size, `${client}-${round}`));
	});
	return summarize('send', r.latencies, r.elapsed, r.errorCount, codes(r.errors));
}

/** Fill every conversation up to `history` messages (the newest page a 0.5 read returns is 100). */
export async function fillHistory(adapter: Adapter, world: World, p: Parameters, log: (s: string) => void) {
	const t = performance.now();
	const sends = world.conversations.flatMap((c) =>
		Array.from({length: p.history}, (_, i) => ({c, from: c.members[i % 2], i})),
	);
	await mapLimit(sends, 32, ({c, from, i}) => adapter.send(from, c, content(p.size, `history-${i}`)));
	log(`setup: ${sends.length} messages of history sent in ${ms(t)}`);
}

export async function runRead(adapter: Adapter, world: World, p: Parameters): Promise<Summary> {
	let messages = 0;
	const r = await closedLoop(world.users.length, p.duration * 1000, async (client, round) => {
		const mine = world.byUser[client];
		// awaited first: `messages += await` would add to the value read before the await
		const n = await adapter.read(world.users[client], mine[round % mine.length]);
		messages += n;
	});
	return summarize('read', r.latencies, r.elapsed, r.errorCount, {
		messagesPerRead: r.latencies.length ? messages / r.latencies.length : 0,
		...codes(r.errors),
	});
}

export async function runList(adapter: Adapter, world: World, p: Parameters): Promise<Summary> {
	let listed = 0;
	const r = await closedLoop(world.users.length, p.duration * 1000, async (client) => {
		const n = await adapter.listConversations(world.users[client]);
		listed += n;
	});
	return summarize('list', r.latencies, r.elapsed, r.errorCount, {
		conversationsPerList: r.latencies.length ? listed / r.latencies.length : 0,
		...codes(r.errors),
	});
}

/**
 * Live fan-out: every user of the world holds its live inbox socket, then the
 * `send` loop runs (each client sending in its conversations, one after
 * another) and every message is timed from the start of its send to its
 * arrival on the sockets it is pushed to: the recipient's and the sender's own
 * (its other devices). `live` is the time to the recipient's socket,
 * `live-own` to the sender's, `live-send` the send itself (the HTTP answer,
 * with the sockets open); a message not pushed to both within 5 s of the last
 * delivery is `incomplete`. Each message is named by its content.
 */
export async function runLive(
	adapter: Adapter,
	world: World,
	p: Parameters,
	log: (s: string) => void,
): Promise<Summary[]> {
	if (!adapter.openInbox) {
		throw new Error(`the ${adapter.name} adapter has no live inbox channel`);
	}
	const t = performance.now();
	const sockets: InboxConnection[] = await mapLimit(world.users, 16, (u) => adapter.openInbox!(u));
	log(`setup: ${sockets.length} live inbox sockets opened in ${ms(t)}`);
	try {
		const run = Math.random().toString(36).slice(2, 8);
		const pattern = new RegExp(`^live-${run}-(\\d+)-(\\d+):`);
		/** per message (`client-round`): when its send started, who sent it, to whom */
		const sent = new Map<string, {at: number; from: number; to: number}>();
		const toRecipient: number[] = [];
		const toSender: number[] = [];
		const index = new Map(world.users.map((u, i) => [u, i]));
		sockets.forEach((socket, i) => {
			socket.onMessage((text, receivedAt) => {
				const match = pattern.exec(text);
				const entry = match && sent.get(`${match[1]}-${match[2]}`);
				if (!entry) {
					return;
				}
				if (i === entry.to) {
					toRecipient.push(receivedAt - entry.at);
				} else if (i === entry.from) {
					toSender.push(receivedAt - entry.at);
				}
			});
		});
		const r = await closedLoop(world.users.length, p.duration * 1000, (client, round) => {
			const mine = world.byUser[client];
			const conversation = mine[round % mine.length];
			const other = conversation.members[0] === world.users[client] ? conversation.members[1] : conversation.members[0];
			sent.set(`${client}-${round}`, {at: performance.now(), from: client, to: index.get(other)!});
			return adapter.send(world.users[client], conversation, content(p.size, `live-${run}-${client}-${round}`));
		});
		// the deliveries still in flight: until every sent message reached both sockets, or 5 s without one
		const expected = r.latencies.length;
		let idleSince = performance.now();
		let seen = toRecipient.length + toSender.length;
		while ((toRecipient.length < expected || toSender.length < expected) && performance.now() - idleSince < 5000) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (toRecipient.length + toSender.length !== seen) {
				seen = toRecipient.length + toSender.length;
				idleSince = performance.now();
			}
		}
		return [
			summarize('live-send', r.latencies, r.elapsed, r.errorCount, {sockets: sockets.length, ...codes(r.errors)}),
			summarize('live', toRecipient, r.elapsed, 0, {incomplete: expected - toRecipient.length}),
			summarize('live-own', toSender, r.elapsed, 0, {incomplete: expected - toSender.length}),
		];
	} finally {
		await Promise.all(sockets.map((s) => s.close()));
	}
}

function codes(errors: Record<string, number>) {
	return Object.fromEntries(Object.entries(errors).map(([code, n]) => [`error:${code}`, n]));
}

/**
 * `roomSize` sockets join the room (each its own registered user, each from its
 * own loopback address when the target is local), then `rate` messages a second
 * for `duration` seconds, the sockets taking turns to send. Each message is
 * timed from its send to its delivery on every socket (the sender's included,
 * since a room broadcasts to all): `room` is the time to the LAST delivery,
 * `room-delivery` every single delivery, `room-join` each socket's connect and
 * login.
 */
export async function runRoom(
	adapter: Adapter,
	p: Parameters,
	options: {loopback: boolean},
	log: (s: string) => void,
): Promise<Summary[]> {
	const t = performance.now();
	const users = await mapLimit(Array.from({length: p.roomSize}), 16, () => adapter.createUser());
	await mapLimit(users, 16, (u) => adapter.register(u));
	log(`setup: ${users.length} room users registered in ${ms(t)}`);
	if (!options.loopback) {
		log(`warning: a remote target sees every socket from one IP, so the room's per-IP rate limit applies to all`);
	}

	const joinStart = performance.now();
	const joinLatencies: number[] = [];
	const sockets: RoomConnection[] = [];
	try {
		const joinErrors: Record<string, number> = {};
		await mapLimit(users, 16, async (user, i) => {
			const t0 = performance.now();
			try {
				const socket = await adapter.joinRoom(
					user,
					adapter.room,
					options.loopback ? {localAddress: sourceAddress(i)} : undefined,
				);
				sockets.push(socket);
				joinLatencies.push(performance.now() - t0);
			} catch (err) {
				const code = errorCode(err);
				joinErrors[code] = (joinErrors[code] || 0) + 1;
			}
		});
		const joinElapsed = performance.now() - joinStart;
		if (sockets.length === 0) {
			throw new Error(`no socket could join ${adapter.room}: ${JSON.stringify(joinErrors)}`);
		}

		const run = Math.random().toString(36).slice(2, 8);
		const prefix = `load-${run}-`;
		const sentAt = new Map<number, number>();
		const delivered = new Map<number, number>();
		const lastDelivery: number[] = [];
		const deliveries: number[] = [];
		const refused: Record<string, number> = {};
		for (const socket of sockets) {
			socket.onMessage((text, receivedAt) => {
				if (!text.startsWith(prefix)) {
					return;
				}
				const seq = Number(text.slice(prefix.length));
				const sent = sentAt.get(seq);
				if (sent === undefined) {
					return;
				}
				deliveries.push(receivedAt - sent);
				const count = (delivered.get(seq) || 0) + 1;
				delivered.set(seq, count);
				if (count === sockets.length) {
					lastDelivery.push(receivedAt - sent);
				}
			});
			socket.onError((code) => {
				refused[code] = (refused[code] || 0) + 1;
			});
		}

		const interval = 1000 / p.rate;
		const total = Math.max(1, Math.round(p.rate * p.duration));
		const sendStart = performance.now();
		for (let seq = 0; seq < total; seq++) {
			const due = sendStart + seq * interval;
			const wait = due - performance.now();
			if (wait > 0) {
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
			sentAt.set(seq, performance.now());
			sockets[seq % sockets.length].send(`${prefix}${seq}`);
		}
		const sendElapsed = performance.now() - sendStart;
		// the deliveries still in flight: until every message is complete, or 5 s without a delivery
		let idleSince = performance.now();
		let seen = deliveries.length;
		while (lastDelivery.length + sum(refused) < total && performance.now() - idleSince < 5000) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (deliveries.length !== seen) {
				seen = deliveries.length;
				idleSince = performance.now();
			}
		}
		const incomplete = total - lastDelivery.length;
		return [
			summarize('room-join', joinLatencies, joinElapsed, users.length - joinLatencies.length, {
				sockets: sockets.length,
				...codes(joinErrors),
			}),
			summarize('room', lastDelivery, sendElapsed, incomplete, {
				sockets: sockets.length,
				targetRate: p.rate,
				sent: total,
				incomplete,
				...codes(refused),
			}),
			summarize('room-delivery', deliveries, sendElapsed, 0, {expected: total * sockets.length}),
		];
	} finally {
		await Promise.all(sockets.map((s) => s.close()));
	}
}

function sum(record: Record<string, number>) {
	return Object.values(record).reduce((a, b) => a + b, 0);
}

/**
 * The loopback address room socket `i` connects from. A room rate-limits by
 * the client's IP (`RateLimiter`: one action per 5 s past a 20 s burst), so
 * sockets sharing 127.0.0.1 would all share one limit and the scenario would
 * measure the limiter, not the fan-out. Every 127.0.0.0/8 address is the
 * loopback on Linux, so each socket gets its own, from 127.0.1.1 up.
 */
export function sourceAddress(i: number): string {
	return `127.0.${1 + Math.floor(i / 250)}.${1 + (i % 250)}`;
}
