// The ids 0.6's messaging rests on: a messageID's time (the server's window
// check), a ULID of another time (a send composed again under the server's
// clock), and the two members a 1:1 conversationID names.
import {describe, it, expect} from 'vitest';
import {newULID, ulidAt, ulidTime} from './ids.js';
import {conversationIDOf, membersOfConversationID} from './index.js';

describe('a ULID', () => {
	it('carries its time, newULID and ulidAt alike', () => {
		const now = Date.now();
		expect(ulidTime(newULID(now))).toBe(now);
		expect(ulidTime(ulidAt(now - 3_600_000))).toBe(now - 3_600_000);
		expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(1469922850259);
	});

	it('has no time when malformed', () => {
		expect(ulidTime('short')).toBeNaN();
		expect(ulidTime('U1ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNaN();
	});
});

describe('membersOfConversationID', () => {
	const a = `0x${'a'.repeat(40)}` as const;
	const b = `0x${'b'.repeat(40)}` as const;

	it('answers the two members of a 1:1 conversationID', () => {
		expect(membersOfConversationID(conversationIDOf([a, b]))).toEqual([b, a]);
	});

	it('answers none for another form: the other order, an account with itself, a group', () => {
		expect(membersOfConversationID(`${a}${b}`)).toBeUndefined();
		expect(membersOfConversationID(`${a}${a}`)).toBeUndefined();
		expect(membersOfConversationID(conversationIDOf([a, b, `0x${'c'.repeat(40)}`]))).toBeUndefined();
	});
});
