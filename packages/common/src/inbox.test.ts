// How a server reads a client frame of the live inbox (`readInboxClientFrame`,
// inbox.ts "Room to grow the socket's wire"): a sync, a frame of a type it does
// not know (ignored), or invalid (the socket is closed).
import {describe, expect, it} from 'vitest';
import {readInboxClientFrame} from './inbox.js';

describe('readInboxClientFrame', () => {
	it('reads a sync, from text or bytes', () => {
		const text = JSON.stringify({type: 'sync', since: {'ns:0xabc': 3}});
		const expected = {kind: 'sync', sync: {type: 'sync', since: {'ns:0xabc': 3}}};
		expect(readInboxClientFrame(text)).toEqual(expected);
		expect(readInboxClientFrame(new TextEncoder().encode(text))).toEqual(expected);
		expect(readInboxClientFrame(new TextEncoder().encode(text).buffer as ArrayBuffer)).toEqual(expected);
	});

	it('names a frame of another type as unknown, whatever else it holds', () => {
		expect(readInboxClientFrame('{"type": "typing", "conversation": "ns:0xabc"}')).toEqual({
			kind: 'unknown',
			type: 'typing',
		});
		expect(readInboxClientFrame('{"type": ""}')).toEqual({kind: 'unknown', type: ''});
	});

	it('names anything else invalid, a malformed sync included', () => {
		for (const data of [
			'not json',
			'null',
			'42',
			'"sync"',
			'[{"type": "sync"}]',
			'{}',
			'{"type": 1}',
			'{"type": "sync"}',
			'{"type": "sync", "since": {"k": -1}}',
		]) {
			expect(readInboxClientFrame(data), data).toEqual({kind: 'invalid'});
		}
	});
});
