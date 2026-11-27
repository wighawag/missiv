// The missiv message on the client (ADR-0004, ADR-0006 "The message"): one
// ciphertext composed and signed once, read by both members, each reader
// fetching the sender's key set by `senderKeyRef` through `getKeySet` and
// checking it before the signature. The store and the send route are not on
// this format yet (`sqlite-conversation-store-and-api`): messages here go from
// `composeMessage` straight to `openMessage`, the key sets from the in-process
// server's directory.
import {describe, it, expect, beforeEach} from 'vitest';
import {composeIntroduction, composeMessage, openMessage, type KeySetSource} from '@missiv/client';
import {MessageToSendSchema, signMessage, type Message, type MessageToSend} from '@missiv/common';
import {
	APP_ORIGIN,
	conversationIDOf,
	createHarness,
	createUser,
	DOMAIN,
	NAMESPACE,
	newKeySet,
	publicOf,
	type Harness,
	type TestUser,
} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;
let C: TestUser;

beforeEach(async () => {
	h = createHarness();
	[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
	await h.registerAll([A, B, C]);
});

const destination = {domain: DOMAIN, namespace: NAMESPACE};
const reader = (user: TestUser, keySet = user.keySet) => ({address: user.address, domain: DOMAIN, keySet});
/** As the store will return it: the message as sent, plus what the store assigns. */
const stored = (message: MessageToSend, seq = 1): Message => ({...message, seq, serverTimestamp: Date.now()});

function fromAToB(text = 'hi B', recipient: TestUser = B) {
	return composeMessage({
		destination,
		sender: {address: A.address, keySet: A.keySet},
		recipient: {address: recipient.address, keySet: publicOf(recipient.keySet)},
		text,
	});
}

/** The server's directory, counting the key sets asked for. */
function counted(source: KeySetSource = h.api) {
	const asked: string[] = [];
	return {
		asked,
		getKeySet: (action: Parameters<KeySetSource['getKeySet']>[0]) => {
			asked.push(action.keyRef);
			return source.getKeySet(action);
		},
	};
}

describe('a pairwise-v1 message', () => {
	it('is one ciphertext, which both members read', async () => {
		const message = await fromAToB('only for A and B');
		expect(MessageToSendSchema.parse(message)).toEqual(message);
		expect(message).toMatchObject({
			conversationID: conversationIDOf([A.address, B.address]),
			sender: A.address,
			senderKeyRef: A.keyRef,
			scheme: 'pairwise-v1',
			keyID: [A.keyRef, B.keyRef].sort().join(':'),
		});
		expect(message.content).not.toContain('only for A and B');
		expect(await openMessage(stored(message), reader(B), h.api)).toMatchObject({content: 'only for A and B'});
		expect(await openMessage(stored(message), reader(A), h.api)).toMatchObject({content: 'only for A and B'});
	});

	it("fetches the sender's key set by senderKeyRef", async () => {
		const message = await fromAToB('fetched');
		const directory = counted();
		expect(await openMessage(stored(message), reader(B), directory)).toMatchObject({content: 'fetched'});
		expect(directory.asked).toContain(A.keyRef);
	});

	it('is undecryptable for a key set its keyID does not name, not a thrown error', async () => {
		const message = await fromAToB('not for C');
		expect((await openMessage(stored(message), reader(C), h.api)).error?.code).toBe('undecryptable');
		// B reading with another key set (a replaced one, or another app's)
		expect((await openMessage(stored(message), reader(B, newKeySet()), h.api)).error?.code).toBe('undecryptable');
	});

	it('is undecryptable under another keyID, even signed by its sender', async () => {
		const message = await fromAToB('under another keyID');
		const {signature, ...unsigned} = message;
		const moved = {...unsigned, keyID: [A.keyRef, C.keyRef].sort().join(':')};
		const resigned = {...moved, signature: await signMessage(moved, A.keySet.signing.privateKey)};
		expect((await openMessage(stored(resigned), reader(B), h.api)).error?.code).toBe('undecryptable');
	});

	it('is unverified once moved to another conversation, namespace, messageID or content', async () => {
		const message = await fromAToB('moved');
		for (const moved of [
			{...message, conversationID: conversationIDOf([A.address, C.address])},
			{...message, namespace: 'other'},
			{...message, messageID: '01JDQ4ZK8Y3V5W6X7Y8Z9A0B1C'},
			{...message, content: message.content.slice(0, -2) + (message.content.endsWith('AA') ? 'BB' : 'AA')},
		]) {
			expect((await openMessage(stored(moved), reader(B), h.api)).error?.code).toBe('unverified');
		}
		// another domain: not the reader's, nor where the sender's key set is
		expect((await openMessage(stored({...message, domain: 'other.com'}), reader(B), h.api)).error?.code).toBe(
			'unverified',
		);
	});

	it('is unverified when signed by another key than its senderKeyRef names', async () => {
		const message = await fromAToB('forged');
		const {signature, ...unsigned} = message;
		const forged = {...unsigned, signature: await signMessage(unsigned, C.keySet.signing.privateKey)};
		expect((await openMessage(stored(forged), reader(B), h.api)).error?.code).toBe('unverified');
		// C's key set named as A's
		const claimed = {...unsigned, senderKeyRef: C.keyRef};
		const relabelled = {...claimed, signature: await signMessage(claimed, C.keySet.signing.privateKey)};
		expect((await openMessage(stored(relabelled), reader(B), h.api)).error?.code).toBe('unverified');
	});

	it('is unverified when the directory hands out a key set its wallet did not prove, or none', async () => {
		const message = await fromAToB('lying directory');
		const lying: KeySetSource = {
			async getKeySet(action) {
				const {keySet} = await h.api.getKeySet(action);
				return {keySet: keySet && {...keySet, ownershipSignature: B.ownershipSignature}};
			},
		};
		expect((await openMessage(stored(message), reader(B), lying)).error?.code).toBe('unverified');
		const empty: KeySetSource = {getKeySet: async () => ({keySet: undefined})};
		const again = await fromAToB('no key set');
		expect((await openMessage(stored(again), reader(B), empty)).error?.code).toBe('unverified');
	});

	it('throws, and caches nothing, when the directory cannot be reached', async () => {
		const message = await fromAToB('retry me');
		const down: KeySetSource = {
			getKeySet: async () => {
				throw new Error('offline');
			},
		};
		await expect(openMessage(stored(message), reader(B), down)).rejects.toThrow('offline');
		expect(await openMessage(stored(message), reader(B), h.api)).toMatchObject({content: 'retry me'});
	});

	it('stays readable by both after the sender replaced its key set', async () => {
		const message = await fromAToB('before the replacement');
		const second = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(second),
				ownershipSignature: await A.signPublication(second),
			},
			{privateKey: second.signing.privateKey},
		);
		expect(await openMessage(stored(message), reader(B), h.api)).toMatchObject({content: 'before the replacement'});
		// A with the old key set still reads it; with the new one it cannot (keyID names the old)
		expect(await openMessage(stored(message), reader(A), h.api)).toMatchObject({content: 'before the replacement'});
		expect((await openMessage(stored(message), reader(A, second), h.api)).error?.code).toBe('undecryptable');
	});

	it('of a later scheme is undecryptable, not a thrown error', async () => {
		const message = await fromAToB('from the future');
		const future = {...message, scheme: 'sender-key-v1'} as unknown as MessageToSend;
		expect((await openMessage(stored(future), reader(B), h.api)).error?.code).toBe('undecryptable');
	});
});

describe('a clear message (an introduction)', () => {
	it('is the text, signed, read by the recipient', async () => {
		const message = await composeIntroduction({
			destination,
			sender: {address: A.address, keySet: A.keySet},
			recipient: {address: B.address},
			text: 'hello, in clear',
		});
		expect(message).toMatchObject({scheme: 'clear', keyID: null, content: 'hello, in clear'});
		expect(await openMessage(stored(message), reader(B), h.api)).toMatchObject({content: 'hello, in clear'});
		const altered = {...message, content: 'hello, altered'};
		expect((await openMessage(stored(altered), reader(B), h.api)).error?.code).toBe('unverified');
	});
});
