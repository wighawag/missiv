import type {RemoteSQL} from 'remote-sql';
import migrations from './ts/migrations.sql.js';

/** The statements of a migration file: `--` comments dropped, split on `;`. */
export function splitStatements(sql: string): string[] {
	return sql
		.replace(/--[^\n]*/g, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/** The tables the migrations create, dropped by `resetDatabase`. */
const TABLES = [
	'InboxSettings',
	'RequestSignatures',
	'Blocks',
	'Messages',
	'Inbox',
	// 0001_v0_6's, dropped by 0002 (kept here for a database that stopped between them)
	'ConversationParticipants',
	'Conversations',
	'DomainUsers',
	'KeySets',
];
const MIGRATIONS_TABLE = '_missiv_migrations';

/**
 * Apply the migrations the database has not had, in order, recording each in
 * `_missiv_migrations`. Every platform calls it at start, except cf-worker, whose
 * D1 database gets the same files through `wrangler d1 migrations apply`.
 * Statements run one at a time (bun's sqlite cannot prepare an index on a table
 * created in the same batch).
 */
export async function migrate(db: RemoteSQL): Promise<string[]> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT NOT NULL PRIMARY KEY, appliedAt INTEGER NOT NULL)`,
		)
		.all();
	const {results} = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all<{name: string}>();
	const applied = new Set(results.map((row) => row.name));
	const done: string[] = [];
	for (const migration of migrations) {
		if (applied.has(migration.name)) {
			continue;
		}
		for (const statement of splitStatements(migration.sql)) {
			await db.prepare(statement).all();
		}
		await db
			.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, appliedAt) VALUES (?1, ?2)`)
			.bind(migration.name, Date.now())
			.all();
		done.push(migration.name);
	}
	return done;
}

/** Drop every table and migrate again: an empty database. */
export async function resetDatabase(db: RemoteSQL): Promise<void> {
	for (const table of [...TABLES, MIGRATIONS_TABLE]) {
		await db.prepare(`DROP TABLE IF EXISTS ${table}`).all();
	}
	await migrate(db);
}
