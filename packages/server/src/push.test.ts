import {describe, expect, it} from 'vitest';
import {createHTTPPushNotifier, parsePushTokens, pushKey, pushMessage, type NewMessageNotification} from './push.js';

const notification: NewMessageNotification = {
	domain: 'test.com',
	namespace: '',
	conversationID: '0xconv',
	messageID: '01JABCDEF',
	sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	appOrigin: 'https://test.com',
};

function recordingFetch(statuses: number[]) {
	const calls: {url: string; init: RequestInit}[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		calls.push({url, init});
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
		return new Response('{}', {status});
	}) as unknown as typeof globalThis.fetch;
	return {calls, fetch};
}

function notifier(statuses: number[], tokens = 'test.com=secret') {
	const {calls, fetch} = recordingFetch(statuses);
	const logs: string[] = [];
	const n = createHTTPPushNotifier({
		url: 'https://push.example/',
		tokens: parsePushTokens(tokens),
		fetch,
		sleep: async () => {},
		retries: 2,
		log: (m) => logs.push(m),
	});
	return {n, calls, logs};
}

describe('the message of a push', () => {
	it('is pinned: the sender and never the content, the root plus the hand-off, the conversation tag, data.missiv', () => {
		expect(pushMessage(notification)).toStrictEqual({
			web_push: 8030,
			notification: {
				title: 'New message',
				body: 'From 0xaaaa...aaaa',
				// {"missiv":{"type":"message","namespace":"","conversationID":"0xconv","recipient":"0xbbbb...bbbb"}}
				navigate:
					'https://test.com/#push-handoff=eyJtaXNzaXYiOnsidHlwZSI6Im1lc3NhZ2UiLCJuYW1lc3BhY2UiOiIiLCJjb252ZXJzYXRpb25JRCI6IjB4Y29udiIsInJlY2lwaWVudCI6IjB4YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9fQ',
				tag: 'missiv:0xconv',
				data: {
					missiv: {
						type: 'message',
						domain: 'test.com',
						namespace: '',
						conversationID: '0xconv',
						messageID: '01JABCDEF',
						sender: notification.sender,
						recipient: notification.recipient,
					},
				},
			},
		});
	});

	it('leads to the domain when the recipient has no app origin', () => {
		const {appOrigin, ...withoutOrigin} = notification;
		expect(pushMessage(withoutOrigin).notification.navigate).toMatch(/^https:\/\/test\.com\/#push-handoff=/);
	});

	// Web Push carries 4096 bytes of record (RFC 8030/8291), about 3993 of plaintext:
	// the schema limits in @missiv/common keep the message well under it.
	const size = (n: NewMessageNotification) => new TextEncoder().encode(JSON.stringify(pushMessage(n))).length;
	const longest: NewMessageNotification = {
		...notification,
		domain: 'd'.repeat(253),
		namespace: 'n'.repeat(64),
		conversationID: 'c'.repeat(256),
		messageID: '01JABCDEFGHJKMNPQRSTVWXYZ0',
		appOrigin: 'o'.repeat(300),
	};

	it('stays under 3500 bytes with every field at its schema maximum', () => {
		expect(size(longest)).toBeLessThan(3500);
	});

	it('stays under 3500 bytes with a namespace JSON escapes as \\uXXXX', () => {
		expect(size({...longest, namespace: '\u0001'.repeat(64)})).toBeLessThan(3500);
	});
});

describe('the push of a new message', () => {
	it('is one POST /api/push with the domain token, the idempotency key and no content', async () => {
		const {n, calls} = notifier([200]);
		await n.notify(notification);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe('https://push.example/api/push');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer secret');
		expect(headers['idempotency-key']).toBe(`missiv:test.com:01JABCDEF:${notification.recipient}`);
		const body = JSON.parse(calls[0].init.body as string);
		expect(body.address).toBe(notification.recipient);
		expect(body.domain).toBe('test.com');
		expect(body.message).toEqual(pushMessage(notification));
	});

	it('retries a failed send (502) with the same key', async () => {
		const {n, calls} = notifier([502, 200]);
		await n.notify(notification);
		expect(calls.length).toBe(2);
		const keys = calls.map((call) => (call.init.headers as Record<string, string>)['idempotency-key']);
		expect(new Set(keys)).toEqual(new Set([pushKey(notification)]));
	});

	it('retries a busy key (409), bounded, then logs', async () => {
		const {n, calls, logs} = notifier([409]);
		await n.notify(notification);
		expect(calls.length).toBe(3);
		expect(logs.length).toBe(1);
	});

	it('never retries a refused token', async () => {
		const {n, calls, logs} = notifier([403]);
		await n.notify(notification);
		expect(calls.length).toBe(1);
		expect(logs[0]).toMatch(/refused the token/);
	});

	it('sends nothing for a domain without a token, and logs that once', async () => {
		const {n, calls, logs} = notifier([200], 'other.com=x');
		await n.notify(notification);
		await n.notify({...notification, messageID: 'another'});
		expect(calls.length).toBe(0);
		expect(logs.length).toBe(1);
	});

	it('never retries a refused request (400)', async () => {
		const {n, calls, logs} = notifier([400]);
		await n.notify(notification);
		expect(calls.length).toBe(1);
		expect(logs.length).toBe(1);
	});

	it('parses PUSH_TOKENS', () => {
		expect([...parsePushTokens(' a.com=1, b.com = 2,broken,')]).toEqual([
			['a.com', '1'],
			['b.com', '2'],
		]);
	});
});
