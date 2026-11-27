// What follows an append where the live inbox is routed (cf-worker's Inbox
// objects, `LiveInboxRouter`): the router's objects push their own frames, so
// the server publishes nothing and reads no inbox row; the push skip still asks
// the router whether the recipient is online.
import {describe, expect, it} from 'vitest';
import type {Address, Message} from '@missiv/common';
import {deliverAppended} from './delivery.js';
import type {NewMessageNotification} from './push.js';
import type {Stores} from './stores/ports.js';
import type {ServerOptions} from './types.js';

const A = `0x${'aa'.repeat(20)}` as Address;
const B = `0x${'bb'.repeat(20)}` as Address;
const message = {domain: 'test.com', namespace: 'ns', conversationID: `${B}${A}`, messageID: '01J', seq: 1} as Message;

function routed(online: boolean, env: Record<string, string>) {
	const notified: NewMessageNotification[] = [];
	const asked: Address[] = [];
	const options = {
		getLiveInboxRouter: () => ({
			async isOnline(_domain: string, user: Address) {
				asked.push(user);
				return online;
			},
			async accept(): Promise<Response> {
				throw new Error('not here');
			},
		}),
		getPushNotifier: () => ({
			async notify(notification: NewMessageNotification) {
				notified.push(notification);
			},
		}),
	} as unknown as ServerOptions<Record<string, string>>;
	// any read of the stores would throw: a routed live inbox needs none
	const stores = new Proxy({}, {get: () => new Proxy({}, {get: () => () => Promise.reject(new Error('read'))})});
	const run = () =>
		deliverAppended(
			options,
			env,
			stores as Stores,
			{status: 'appended', message, pushTo: [{address: B, appOrigin: 'https://test.com'}], pendingInboxUpdates: []},
			{sender: A, recipient: B},
		);
	return {run, notified, asked};
}

describe('deliverAppended with a routed live inbox', () => {
	it('publishes nothing itself and pushes the recipient', async () => {
		const {run, notified, asked} = routed(true, {});
		await run();
		expect(notified.map((n) => n.recipient)).toEqual([B]);
		expect(asked).toEqual([]);
	});

	it('with PUSH_SKIP_WHEN_ONLINE, asks the router and skips an online recipient', async () => {
		const online = routed(true, {PUSH_SKIP_WHEN_ONLINE: 'true'});
		await online.run();
		expect(online.asked).toEqual([B]);
		expect(online.notified).toEqual([]);
		const offline = routed(false, {PUSH_SKIP_WHEN_ONLINE: 'true'});
		await offline.run();
		expect(offline.notified.map((n) => n.recipient)).toEqual([B]);
	});
});
