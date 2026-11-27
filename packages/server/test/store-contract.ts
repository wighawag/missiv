// The store contract (ADR-0005, ADR-0006): what every implementation of the
// KeyDirectory, ConversationStore and Inbox ports must do, as one suite
// parameterized by the implementation and by the test runner, so the same
// assertions run on libSQL under vitest (`store-contract.libsql.test.ts`) and
// on bun:sqlite under `bun test` (`platforms/bun/test/store-contract.test.ts`)
// and on Cloudflare's Durable Object stores under the Workers runtime
// (`platforms/cf-worker/test/store-contract.test.ts`).
//
// The stores are below the route's checks: messages here carry well-formed but
// unchecked signatures (the route verifies them, `test/client-server`).
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {conversationIDOf, newULID, type Address, type MessageToSend} from '@missiv/common';
import type {Stores} from '../src/stores/ports.js';

/** The runner's functions the suite uses (vitest's and bun:test's share them). */
export type Runner = {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => Promise<void>): void;
	expect: (value: unknown) => any;
};

/** An implementation on ONE SQL database: a fresh, migrated database, and the stores of the implementation over it. */
export type SQLImplementation = {
	name: string;
	create(db: RemoteSQL): Stores;
	/** a new empty database, migrated */
	database(): Promise<RemoteSQL>;
};

/**
 * An implementation whose stores are not one SQL database (Cloudflare's: D1 for
 * the KeyDirectory, a Durable Object per conversation and per inbox). Every
 * assertion runs on it but the one that counts and explains a send's SQL
 * statements, which only means something for one database. The suite keeps
 * every test's data apart by fresh addresses, so `stores()` may answer stores
 * over storage shared by every test.
 */
export type StoresImplementation = {
	name: string;
	stores(): Promise<Stores>;
};

export type Implementation = SQLImplementation | StoresImplementation;

type Recorded = {sql: string; args: unknown[]};

/** The database as the stores see it, recording every statement they run (its SQL and arguments). */
function recording(db: RemoteSQL) {
	const statements: Recorded[] = [];
	let batches = 0;
	function wrap(statement: SQLPreparedStatement, recorded: Recorded): SQLPreparedStatement {
		return {
			bind(...values: unknown[]) {
				return wrap(statement.bind(...values), {sql: recorded.sql, args: [...recorded.args, ...values]});
			},
			all() {
				statements.push(recorded);
				return statement.all();
			},
			// the underlying statement, for batch
			...({inner: statement, recorded} as object),
		} as SQLPreparedStatement;
	}
	const recorded: RemoteSQL = {
		prepare(sql) {
			return wrap(db.prepare(sql), {sql, args: []});
		},
		batch(list) {
			batches++;
			for (const statement of list) {
				statements.push((statement as unknown as {recorded: Recorded}).recorded);
			}
			return db.batch(list.map((statement) => (statement as unknown as {inner: SQLPreparedStatement}).inner));
		},
	};
	return {
		db: recorded,
		statements,
		get batches() {
			return batches;
		},
		reset() {
			statements.length = 0;
			batches = 0;
		},
	};
}

let counter = 0;
/** A distinct lowercase address. */
function address(): Address {
	counter++;
	return `0x${counter.toString(16).padStart(8, '0')}${'ab'.repeat(16)}` as Address;
}

const DOMAIN = 'test.com';
const NAMESPACE = 'ns';
const SIGNATURE = `0x${'11'.repeat(64)}` as `0x${string}`;
const OTHER_SIGNATURE = `0x${'22'.repeat(64)}` as `0x${string}`;
const KEY_REF = `0x${'33'.repeat(32)}` as `0x${string}`;

function messageOf(
	from: Address,
	to: Address,
	options: {domain?: string; namespace?: string; messageID?: string; signature?: `0x${string}`; content?: string} = {},
): MessageToSend {
	return {
		domain: options.domain ?? DOMAIN,
		namespace: options.namespace ?? NAMESPACE,
		conversationID: conversationIDOf([from, to]),
		messageID: options.messageID ?? newULID(),
		sender: from,
		senderKeyRef: KEY_REF,
		scheme: 'clear',
		keyID: null,
		content: options.content ?? 'hello',
		signature: options.signature ?? SIGNATURE,
	};
}

function scope(a: Address, b: Address, domain = DOMAIN, namespace = NAMESPACE) {
	return {domain, namespace, conversationID: conversationIDOf([a, b])};
}

function hexKey(n: number): `0x${string}` {
	return `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
}

export function storeContract(implementation: Implementation, {describe, it, expect}: Runner) {
	/** a test that does not apply to this implementation: not registered */
	const skip = (_name: string, _body: () => Promise<void>) => {};
	const sql = 'database' in implementation ? implementation : undefined;

	async function setupSQL(sql: SQLImplementation) {
		const db = await sql.database();
		const recorder = recording(db);
		return {db, recorder, stores: sql.create(recorder.db)};
	}

	async function setup() {
		const {db, recorder, stores} = sql
			? await setupSQL(sql)
			: {db: undefined, recorder: undefined, stores: await (implementation as StoresImplementation).stores()};
		let now = 1_000_000;
		async function send(from: Address, to: Address, options: Parameters<typeof messageOf>[2] = {}) {
			const message = messageOf(from, to, options);
			now += 10;
			return {message, result: await stores.conversations.append(message, {sender: from, recipient: to}, now)};
		}
		async function list(user: Address, page: {status?: 'accepted' | 'unaccepted' | 'rejected'; before?: string} = {}) {
			return stores.inbox.listConversations(user, {domain: DOMAIN, namespace: NAMESPACE}, {limit: 100, ...page});
		}
		async function register(user: Address, n: number) {
			await stores.keys.register(user, hexKey(n), now, {
				type: 'register',
				domain: DOMAIN,
				appOrigin: `https://${DOMAIN}`,
				address: user,
				keySet: {signing: {publicKey: hexKey(n + 1)}, encryption: {publicKey: hexKey(n + 2)}},
				ownershipSignature: SIGNATURE,
			});
		}
		return {db, recorder, stores, send, list, register, tick: () => (now += 10)};
	}

	describe(`store contract: ${implementation.name}`, () => {
		describe('ConversationStore.append', () => {
			it('assigns each conversation its own seq from 1, and the server time', async () => {
				const {send} = await setup();
				const [a, b] = [address(), address()];
				const first = await send(a, b);
				const second = await send(b, a);
				expect(first.result.status).toBe('appended');
				expect(second.result.status).toBe('appended');
				if (first.result.status !== 'appended' || second.result.status !== 'appended') return;
				expect(first.result.message.seq).toBe(1);
				expect(second.result.message.seq).toBe(2);
				expect(second.result.message.serverTimestamp).toBeGreaterThan(first.result.message.serverTimestamp);
				expect(first.result.message).toMatchObject({...first.message, seq: 1});
			});

			// statements are only countable on one SQL database (a Durable Object's own
			// SQL is a key lookup by construction: `platforms/cf-worker/src/stores/`)
			(sql ? it : skip)(
				'writes one message row in one transaction of a bounded number of statements, whatever the history',
				async () => {
					const {db: maybeDB, recorder: maybeRecorder, send} = await setup();
					const [db, recorder] = [maybeDB!, maybeRecorder!];
					const [a, b] = [address(), address()];
					await send(a, b);
					recorder.reset();
					await send(a, b);
					const small = {statements: recorder.statements.length, batches: recorder.batches};
					for (let i = 0; i < 300; i++) {
						await send(i % 2 ? a : b, i % 2 ? b : a);
					}
					recorder.reset();
					const {message} = await send(a, b);
					expect({statements: recorder.statements.length, batches: recorder.batches}).toEqual(small);
					expect(recorder.batches).toBe(1);
					// the dedup read, the append, two inbox rows, the lift of the sender's block, the read of what is stored
					expect(recorder.statements.length).toBeLessThanOrEqual(6);
					// every statement a lookup on a key (or a constant row), none a scan of the conversation or a sort
					for (const statement of recorder.statements) {
						const {results} = await db
							.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
							.bind(...statement.args)
							.all<{detail: string}>();
						for (const step of results) {
							expect(`${step.detail}`).not.toMatch(/^SCAN (?!CONSTANT ROW)|TEMP B-TREE/);
						}
					}
					const {results} = await db
						.prepare(`SELECT count(*) AS n FROM Messages WHERE messageID = ?1`)
						.bind(message.messageID)
						.all<{n: number}>();
					expect(Number(results[0].n)).toBe(1);
				},
			);

			it('answers a retry (same messageID, same signature) with the stored seq, storing nothing', async () => {
				const {stores, send, list} = await setup();
				const [a, b] = [address(), address()];
				const {message} = await send(a, b);
				await send(a, b);
				const before = await list(b);
				const retry = await stores.conversations.append(message, {sender: a, recipient: b}, 2_000_000);
				expect(retry.status).toBe('duplicate');
				if (retry.status !== 'duplicate') return;
				expect(retry.message.seq).toBe(1);
				expect(await list(b)).toEqual(before);
				const page = await stores.conversations.listMessages(a, scope(a, b), {limit: 10});
				expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
			});

			it('refuses the same messageID with another signature as a conflict, changing nothing', async () => {
				const {stores, send, list} = await setup();
				const [a, b] = [address(), address()];
				const {message} = await send(a, b);
				const before = await list(b);
				const forged = {...message, content: 'other', signature: OTHER_SIGNATURE};
				expect((await stores.conversations.append(forged, {sender: a, recipient: b}, 2_000_000)).status).toBe(
					'conflict',
				);
				const page = await stores.conversations.listMessages(b, scope(a, b), {limit: 10});
				expect(page.messages.map((m) => m.content)).toEqual(['hello']);
				expect(await list(b)).toEqual(before);
			});

			it('keeps the same two members apart per namespace and per domain: sequences and statuses', async () => {
				const {stores, send} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b, {namespace: 'one'});
				await send(a, b, {namespace: 'one'});
				const two = await send(a, b, {namespace: 'two'});
				const other = await send(a, b, {domain: 'other.com'});
				expect(two.result.status === 'appended' && two.result.message.seq).toBe(1);
				expect(other.result.status === 'appended' && other.result.message.seq).toBe(1);
				await stores.inbox.accept(b, scope(a, b, DOMAIN, 'one'));
				const one = await stores.inbox.listConversations(b, {domain: DOMAIN, namespace: 'one'}, {limit: 10});
				const inTwo = await stores.inbox.listConversations(b, {domain: DOMAIN, namespace: 'two'}, {limit: 10});
				const inOther = await stores.inbox.listConversations(
					b,
					{domain: 'other.com', namespace: NAMESPACE},
					{limit: 10},
				);
				expect(one.conversations.map((c) => [c.status, c.lastSeq])).toEqual([['accepted', 2]]);
				expect(inTwo.conversations.map((c) => [c.status, c.lastSeq])).toEqual([['unaccepted', 1]]);
				expect(inOther.conversations.map((c) => [c.status, c.lastSeq])).toEqual([['unaccepted', 1]]);
				const messages = await stores.conversations.listMessages(b, scope(a, b, DOMAIN, 'two'), {limit: 10});
				expect(messages.messages).toHaveLength(1);
			});

			it('names the registered recipient to push to, and no unregistered one', async () => {
				const {send, register} = await setup();
				const [a, b, c] = [address(), address(), address()];
				await register(b, 100);
				const toB = await send(a, b);
				const toC = await send(a, c);
				expect(toB.result.status === 'appended' && toB.result.pushTo).toEqual([
					{address: b, appOrigin: `https://${DOMAIN}`},
				]);
				expect(toC.result.status === 'appended' && toC.result.pushTo).toEqual([]);
			});
		});

		describe('ConversationStore.listMessages', () => {
			it('pages by seq: after returns only newer ones in order, before pages back, neither the newest', async () => {
				const {stores, send} = await setup();
				const [a, b] = [address(), address()];
				for (let i = 0; i < 7; i++) {
					await send(a, b, {content: `m${i + 1}`});
				}
				const key = scope(a, b);
				const seqs = async (page: {after?: number; before?: number; limit: number}) => {
					const result = await stores.conversations.listMessages(b, key, page);
					return [result.messages.map((m) => m.seq), result.hasMore];
				};
				expect(await seqs({after: 4, limit: 10})).toEqual([[5, 6, 7], false]);
				expect(await seqs({after: 2, limit: 3})).toEqual([[3, 4, 5], true]);
				expect(await seqs({after: 7, limit: 3})).toEqual([[], false]);
				expect(await seqs({limit: 3})).toEqual([[5, 6, 7], true]);
				expect(await seqs({before: 5, limit: 3})).toEqual([[2, 3, 4], true]);
				expect(await seqs({before: 3, limit: 3})).toEqual([[1, 2], false]);
				const [message] = (await stores.conversations.listMessages(b, key, {after: 6, limit: 1})).messages;
				expect(message).toMatchObject({content: 'm7', sender: a, scheme: 'clear', keyID: null, seq: 7});
			});
		});

		describe('Inbox', () => {
			it('lists conversations newest message first, by status, with stable cursors', async () => {
				const {send, list, stores} = await setup();
				const me = address();
				const others = [address(), address(), address(), address(), address()];
				for (const other of others) {
					await send(other, me);
				}
				await stores.inbox.accept(me, scope(others[1], me));
				await stores.inbox.accept(me, scope(others[3], me));
				const all = await list(me);
				expect(all.conversations.map((c) => c.members.find((m) => m !== me))).toEqual([...others].reverse());
				const accepted = await list(me, {status: 'accepted'});
				expect(accepted.conversations.map((c) => c.conversationID)).toEqual([
					scope(others[3], me).conversationID,
					scope(others[1], me).conversationID,
				]);
				expect((await list(me, {status: 'unaccepted'})).conversations).toHaveLength(3);

				// two by two: every conversation once, in order
				const paged: string[] = [];
				let before: string | undefined;
				do {
					const page = await stores.inbox.listConversations(
						me,
						{domain: DOMAIN, namespace: NAMESPACE},
						{limit: 2, before},
					);
					paged.push(...page.conversations.map((c) => c.conversationID));
					before = page.cursor;
				} while (before);
				expect(paged).toEqual(all.conversations.map((c) => c.conversationID));
			});

			it('pages conversations sharing a lastMessageAt without skipping or repeating one', async () => {
				const {stores} = await setup();
				const me = address();
				const others = [address(), address(), address()];
				for (const other of others) {
					await stores.inbox.update({...scope(other, me), user: me, seq: 1, lastMessageAt: 5, own: false});
				}
				const first = await stores.inbox.listConversations(me, {domain: DOMAIN, namespace: NAMESPACE}, {limit: 2});
				const second = await stores.inbox.listConversations(
					me,
					{domain: DOMAIN, namespace: NAMESPACE},
					{limit: 2, before: first.cursor},
				);
				const ids = [...first.conversations, ...second.conversations].map((c) => c.conversationID);
				expect(new Set(ids).size).toBe(3);
				expect(second.cursor).toBeUndefined();
			});

			it("derives unread from lastReadSeq: the sender's own message is read, markRead never goes back", async () => {
				const {send, list, stores} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b);
				await send(a, b);
				const [forA] = (await list(a)).conversations;
				const [forB] = (await list(b)).conversations;
				expect([forA.lastSeq, forA.lastReadSeq, forA.status]).toEqual([2, 2, 'accepted']);
				expect([forB.lastSeq, forB.lastReadSeq, forB.status]).toEqual([2, 0, 'unaccepted']);
				await stores.inbox.markRead(b, scope(a, b), 1);
				expect((await list(b)).conversations[0].lastReadSeq).toBe(1);
				await stores.inbox.markRead(b, scope(a, b), 0);
				expect((await list(b)).conversations[0].lastReadSeq).toBe(1);
				await stores.inbox.markRead(b, scope(a, b), 99);
				expect((await list(b)).conversations[0].lastReadSeq).toBe(2);
				await send(b, a);
				const [replied] = (await list(b)).conversations;
				expect([replied.lastSeq, replied.lastReadSeq, replied.status]).toEqual([3, 3, 'accepted']);
				expect((await list(a)).conversations[0].lastReadSeq).toBe(2);
			});

			it('answers one inbox row by its conversation, as the list has it, and none for a non-member', async () => {
				const {send, list, stores} = await setup();
				const [a, b, c] = [address(), address(), address()];
				await send(a, b);
				await stores.inbox.markRead(b, scope(a, b), 1);
				const [listed] = (await list(b)).conversations;
				expect(await stores.inbox.getConversation(b, scope(a, b))).toEqual(listed);
				expect(await stores.inbox.getConversation(c, scope(a, b))).toBeUndefined();
				expect(await stores.inbox.getConversation(b, scope(a, b, DOMAIN, 'another namespace'))).toBeUndefined();
			});

			it('applies an update only above its lastSeq: a repeated and a reordered update change nothing', async () => {
				const {stores, list} = await setup();
				const [a, b] = [address(), address()];
				const update = (seq: number, lastMessageAt: number) =>
					stores.inbox.update({...scope(a, b), user: b, seq, lastMessageAt, own: false});
				await update(2, 200);
				await update(1, 100); // arrives late
				await update(2, 200); // retried
				await update(2, 999); // a retry claiming another time
				const [row] = (await list(b)).conversations;
				expect([row.lastSeq, row.lastMessageAt, row.lastReadSeq, row.status]).toEqual([2, 200, 0, 'unaccepted']);
				await stores.inbox.accept(b, scope(a, b));
				await update(3, 300);
				const [after] = (await list(b)).conversations;
				expect([after.lastSeq, after.lastMessageAt, after.status]).toEqual([3, 300, 'accepted']);
				// the sender's own: accepted and read up to it, still monotonic
				await stores.inbox.update({...scope(a, b), user: a, seq: 3, lastMessageAt: 300, own: true});
				await stores.inbox.update({...scope(a, b), user: a, seq: 1, lastMessageAt: 100, own: true});
				const [mine] = (await list(a)).conversations;
				expect([mine.lastSeq, mine.lastReadSeq, mine.status]).toEqual([3, 3, 'accepted']);
			});
		});

		describe('blocks', () => {
			it('reject blocks the other member across the domain; their messages are stored hidden from the blocker', async () => {
				const {send, list, stores} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b);
				await stores.inbox.reject(b, scope(a, b), a, 1);
				expect((await list(b)).conversations.map((c) => c.status)).toEqual(['rejected']);
				const hidden = await send(a, b, {content: 'after the block'});
				const elsewhere = await send(a, b, {namespace: 'other', content: 'in another namespace'});
				for (const {result} of [hidden, elsewhere]) {
					expect(result.status).toBe('appended');
					if (result.status !== 'appended') return;
					// acknowledged as any other, with its seq; pushed to no one
					expect(result.message.seq).toBeGreaterThan(0);
					expect(result.hiddenFrom).toBe(b);
					expect(result.pushTo).toEqual([]);
				}
				// the sender sees it, the blocker never does
				const forA = await stores.conversations.listMessages(a, scope(a, b), {limit: 10});
				const forB = await stores.conversations.listMessages(b, scope(a, b), {limit: 10});
				expect(forA.messages.map((m) => m.content)).toEqual(['hello', 'after the block']);
				expect(forB.messages.map((m) => m.content)).toEqual(['hello']);
				expect((await list(b)).conversations.map((c) => c.lastSeq)).toEqual([1]);
				expect((await list(a)).conversations.map((c) => c.lastSeq)).toEqual([2]);
				const otherNamespace = await stores.inbox.listConversations(
					b,
					{domain: DOMAIN, namespace: 'other'},
					{limit: 10},
				);
				expect(otherNamespace.conversations).toEqual([]);
				// another domain is not blocked
				const otherDomain = await send(a, b, {domain: 'other.com'});
				expect(otherDomain.result.status === 'appended' && otherDomain.result.hiddenFrom).toBeUndefined();
			});

			it('unblock lifts it for the next messages', async () => {
				const {send, list, stores} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b);
				await stores.inbox.reject(b, scope(a, b), a, 1);
				await send(a, b, {content: 'hidden'});
				await stores.inbox.unblock(b, DOMAIN, a);
				const after = await send(a, b, {content: 'seen'});
				expect(after.result.status === 'appended' && after.result.hiddenFrom).toBeUndefined();
				const forB = await stores.conversations.listMessages(b, scope(a, b), {limit: 10});
				expect(forB.messages.map((m) => [m.seq, m.content])).toEqual([
					[1, 'hello'],
					[3, 'seen'],
				]);
				expect((await list(b)).conversations.map((c) => c.lastSeq)).toEqual([3]);
			});

			it("a message the blocker sends to the blocked member unblocks them in the domain, and accepts the blocker's row", async () => {
				const {send, list, stores} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b);
				await stores.inbox.reject(b, scope(a, b), a, 1);
				await send(a, b, {content: 'hidden'});
				await send(a, b, {namespace: 'other', content: 'hidden elsewhere'});
				const reply = await send(b, a, {content: 'reply'});
				expect(reply.result.status === 'appended' && reply.result.hiddenFrom).toBeUndefined();
				expect((await list(b)).conversations.map((c) => [c.status, c.lastSeq])).toEqual([['accepted', 3]]);
				// a's next messages reach b again, in this namespace and in another one
				const after = await send(a, b, {content: 'seen'});
				expect(after.result.status === 'appended' && after.result.hiddenFrom).toBeUndefined();
				const elsewhere = await send(a, b, {namespace: 'other', content: 'seen elsewhere'});
				expect(elsewhere.result.status === 'appended' && elsewhere.result.hiddenFrom).toBeUndefined();
				const forB = await stores.conversations.listMessages(b, scope(a, b), {limit: 10});
				expect(forB.messages.map((m) => m.content)).toEqual(['hello', 'reply', 'seen']);
				const otherForB = await stores.conversations.listMessages(b, scope(a, b, DOMAIN, 'other'), {limit: 10});
				expect(otherForB.messages.map((m) => m.content)).toEqual(['seen elsewhere']);
				expect((await list(b)).conversations.map((c) => c.lastSeq)).toEqual([4]);
			});

			it('a retry of a message sent before a newer block does not lift it', async () => {
				const {send, stores} = await setup();
				const [a, b] = [address(), address()];
				await send(a, b);
				const {message} = await send(b, a, {content: 'before the block'});
				await stores.inbox.reject(b, scope(a, b), a, 2_000_000);
				const retry = await stores.conversations.append(message, {sender: b, recipient: a}, 2_000_010);
				expect(retry.status).toBe('duplicate');
				const after = await send(a, b, {content: 'still hidden'});
				expect(after.result.status === 'appended' && after.result.hiddenFrom).toBe(b);
			});
		});

		describe('KeyDirectory', () => {
			it('answers the current key set of an account and any registered one by keyRef', async () => {
				const {stores, register} = await setup();
				const a = address();
				await register(a, 1000);
				await register(a, 2000);
				const {domainUser} = await stores.keys.getDomainUser(DOMAIN, a);
				expect(domainUser?.keyRef).toBe(hexKey(2000));
				expect((await stores.keys.getKeySet(DOMAIN, hexKey(1000))).keySet?.user).toBe(a);
				expect((await stores.keys.getDomainUserBySigningKey(hexKey(1001))).domainUser).toBeUndefined();
				expect((await stores.keys.getDomainUserBySigningKey(hexKey(2001))).domainUser?.user).toBe(a);
			});

			it('remembers a request signature for its window: a second use is refused', async () => {
				const {stores} = await setup();
				expect(await stores.keys.acceptRequestSignature('sig', 100, 0)).toBe(true);
				expect(await stores.keys.acceptRequestSignature('sig', 100, 50)).toBe(false);
				expect(await stores.keys.acceptRequestSignature('sig', 300, 200)).toBe(true);
			});
		});
	});
}
