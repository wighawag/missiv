// Migration 0003_inbox_version on a database that already has Inbox rows (one
// made by 0001 and 0002 before this release), on libSQL in memory: every row it
// had gets a version above 0, unique among the user's rows, so a poll from 0
// lists them all, and the next change of a row numbers above them.
import {describe, it, expect} from 'vitest';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import migrations from '../src/schema/ts/migrations.sql.js';
import {migrate, splitStatements} from '../src/schema/migrate.js';
import {createSQLStores} from '../src/stores/sql/index.js';
import {InboxStatus} from '../src/stores/sql/messaging.js';

const DOMAIN = 'migrate.test';
const NAMESPACE = 'ns';
const USER = `0x${'ab'.repeat(20)}` as const;
const OTHER_USER = `0x${'cd'.repeat(20)}` as const;
const conversation = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;

/** a database as 0002 left it: the migrations before 0003 applied and recorded, as `migrate` does */
async function databaseBefore0003() {
	const db = new RemoteLibSQL(createClient({url: ':memory:'}));
	await db
		.prepare(
			'CREATE TABLE IF NOT EXISTS _missiv_migrations (name TEXT NOT NULL PRIMARY KEY, appliedAt INTEGER NOT NULL)',
		)
		.all();
	for (const migration of migrations.filter((m) => m.name < '0003')) {
		for (const statement of splitStatements(migration.sql)) {
			await db.prepare(statement).all();
		}
		await db
			.prepare('INSERT INTO _missiv_migrations (name, appliedAt) VALUES (?1, ?2)')
			.bind(migration.name, Date.now())
			.all();
	}
	return db;
}

async function insertRow(db: RemoteLibSQL, user: string, n: number, lastSeq: number, lastReadSeq: number) {
	await db
		.prepare(
			`INSERT INTO Inbox (user, domain, namespace, conversationID, status, lastSeq, lastReadSeq, lastMessageAt)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		)
		.bind(user, DOMAIN, NAMESPACE, conversation(n), InboxStatus.Accepted, lastSeq, lastReadSeq, 1_000 + n)
		.all();
}

describe('migration 0003_inbox_version on a database with Inbox rows', () => {
	it('numbers every existing row above 0, lists them all from 0, and numbers the next change above them', async () => {
		const db = await databaseBefore0003();
		await insertRow(db, USER, 1, 3, 3);
		await insertRow(db, OTHER_USER, 2, 1, 0);
		await insertRow(db, USER, 3, 5, 2);

		expect(await migrate(db)).toEqual(['0003_inbox_version']);
		// applied once: a second start has nothing to do
		expect(await migrate(db)).toEqual([]);

		const {inbox} = createSQLStores(db);
		const all = await inbox.changes(USER, DOMAIN, {since: 0, limit: 100});
		if ('unchanged' in all) throw new Error('expected the existing rows');
		expect(all.conversations.map((c) => c.conversationID)).toEqual([conversation(1), conversation(3)]);
		const versions = all.conversations.map((c) => c.version);
		expect(versions.every((v) => v > 0)).toBe(true);
		expect(new Set(versions).size).toBe(versions.length);
		expect(all.version).toBe(Math.max(...versions));
		expect(await inbox.changes(USER, DOMAIN, {since: all.version, limit: 100})).toEqual({
			version: all.version,
			unchanged: true,
		});

		// a change after the migration takes the user's highest version plus one
		await inbox.markRead(USER, {domain: DOMAIN, namespace: NAMESPACE, conversationID: conversation(3)}, 5);
		const next = await inbox.changes(USER, DOMAIN, {since: all.version, limit: 100});
		if ('unchanged' in next) throw new Error('expected the marked row');
		expect(next.version).toBe(all.version + 1);
		expect(next.conversations.map((c) => [c.conversationID, c.lastReadSeq])).toEqual([[conversation(3), 5]]);
	});
});
