// The push hand-off of @missiv/common (tested here: common has no test runner).
import {describe, expect, it} from 'vitest';
import {
	consumePushHandoff,
	readMissivPushData,
	readMissivPushHandoff,
	splitPushHandoff,
	withPushHandoff,
	type PushHandoffHistory,
} from '@missiv/common';

// The test vector, also printed in the README.
const recipient = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const handoff = {missiv: {type: 'message', namespace: '', conversationID: '0xconv', recipient}};
const encoded =
	'push-handoff=eyJtaXNzaXYiOnsidHlwZSI6Im1lc3NhZ2UiLCJuYW1lc3BhY2UiOiIiLCJjb252ZXJzYXRpb25JRCI6IjB4Y29udiIsInJlY2lwaWVudCI6IjB4YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9fQ';

describe('withPushHandoff', () => {
	it('adds the hand-off as the fragment of a URL without one', () => {
		expect(withPushHandoff('https://app.example/', handoff)).toBe(`https://app.example/#${encoded}`);
	});

	it('treats an empty fragment as none', () => {
		expect(withPushHandoff('https://app.example/#', handoff)).toBe(`https://app.example/#${encoded}`);
	});

	it('appends it as the last segment of an existing fragment', () => {
		expect(withPushHandoff('https://app.example/#/conversations?x=1', handoff)).toBe(
			`https://app.example/#/conversations?x=1&${encoded}`,
		);
	});

	it('encodes UTF-8 as base64url without padding', () => {
		const url = withPushHandoff('https://app.example/', {
			missiv: {type: 'message', namespace: 'é', conversationID: '0xconv', recipient},
		});
		expect(url).toBe(
			'https://app.example/#push-handoff=eyJtaXNzaXYiOnsidHlwZSI6Im1lc3NhZ2UiLCJuYW1lc3BhY2UiOiLDqSIsImNvbnZlcnNhdGlvbklEIjoiMHhjb252IiwicmVjaXBpZW50IjoiMHhiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIn19',
		);
		expect(url.split('push-handoff=')[1]).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe('splitPushHandoff', () => {
	it('round-trips withPushHandoff without a fragment', () => {
		const hash = new URL(withPushHandoff('https://app.example/', handoff)).hash;
		expect(splitPushHandoff(hash)).toStrictEqual({handoff, hash: ''});
	});

	it('round-trips withPushHandoff with a fragment, which comes back byte for byte', () => {
		const hash = new URL(withPushHandoff('https://app.example/#/conversations?x=1', handoff)).hash;
		expect(splitPushHandoff(hash)).toStrictEqual({handoff, hash: '#/conversations?x=1'});
	});

	it('leaves a hash without a hand-off as it is', () => {
		expect(splitPushHandoff('')).toStrictEqual({handoff: undefined, hash: ''});
		expect(splitPushHandoff('#/a&b=1')).toStrictEqual({handoff: undefined, hash: '#/a&b=1'});
		expect(splitPushHandoff('#push-handoff=x&other=1')).toStrictEqual({
			handoff: undefined,
			hash: '#push-handoff=x&other=1',
		});
	});

	it('gives undefined for a malformed or non-object hand-off, and still splits it off', () => {
		expect(splitPushHandoff('#push-handoff=!!!')).toStrictEqual({handoff: undefined, hash: ''});
		expect(splitPushHandoff('#a&push-handoff=bm90IGpzb24')).toStrictEqual({handoff: undefined, hash: '#a'});
		// "[1]" and "1": JSON, but not an object
		expect(splitPushHandoff('#push-handoff=WzFd').handoff).toBeUndefined();
		expect(splitPushHandoff('#push-handoff=MQ').handoff).toBeUndefined();
	});
});

describe('consumePushHandoff', () => {
	function fakeHistory() {
		const calls: {state: unknown; url: string}[] = [];
		const history: PushHandoffHistory = {
			state: {page: 1},
			replaceState(state, _unused, url) {
				calls.push({state, url});
			},
		};
		return {history, calls};
	}

	it('returns the hand-off and removes it, keeping path, query, state and the rest of the fragment', () => {
		const {history, calls} = fakeHistory();
		const location = {pathname: '/app', search: '?q=1', hash: `#/conversations?x=1&${encoded}`};
		expect(consumePushHandoff(location, history)).toStrictEqual(handoff);
		expect(calls).toStrictEqual([{state: {page: 1}, url: '/app?q=1#/conversations?x=1'}]);
	});

	it('removes a fragment that was only the hand-off', () => {
		const {history, calls} = fakeHistory();
		expect(consumePushHandoff({pathname: '/', search: '', hash: `#${encoded}`}, history)).toStrictEqual(handoff);
		expect(calls).toStrictEqual([{state: {page: 1}, url: '/'}]);
	});

	it('does nothing without a hand-off', () => {
		const {history, calls} = fakeHistory();
		expect(consumePushHandoff({pathname: '/', search: '', hash: '#/conversations'}, history)).toBeUndefined();
		expect(consumePushHandoff({pathname: '/', search: '', hash: ''}, history)).toBeUndefined();
		expect(calls).toStrictEqual([]);
	});
});

describe('the readers', () => {
	const data = {
		type: 'message',
		domain: 'test.com',
		namespace: '',
		conversationID: '0xconv',
		messageID: '01JABCDEF',
		sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		recipient,
	};

	it('read a value of their shape, ignoring unknown fields', () => {
		expect(readMissivPushData(data)).toStrictEqual(data);
		expect(readMissivPushData({...data, added: 1})).toStrictEqual(data);
		expect(readMissivPushHandoff(handoff.missiv)).toStrictEqual(handoff.missiv);
		expect(readMissivPushHandoff({...handoff.missiv, added: 1})).toStrictEqual(handoff.missiv);
	});

	it('give undefined for a missing, malformed or other-type value', () => {
		for (const value of [undefined, null, 'x', 1, [], {}]) {
			expect(readMissivPushData(value)).toBeUndefined();
			expect(readMissivPushHandoff(value)).toBeUndefined();
		}
		expect(readMissivPushData({...data, type: 'other'})).toBeUndefined();
		expect(readMissivPushData({...data, conversationID: 1})).toBeUndefined();
		expect(readMissivPushHandoff({...handoff.missiv, type: 'other'})).toBeUndefined();
		expect(readMissivPushHandoff({type: 'message', namespace: ''})).toBeUndefined();
		expect(readMissivPushHandoff({type: 'message', namespace: '', conversationID: '0xconv'})).toBeUndefined();
	});
});
