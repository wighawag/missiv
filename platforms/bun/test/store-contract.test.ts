// The store contract on bun:sqlite (the Bun platform's database, through its
// RemoteBunSQL, whose batch is one bun:sqlite transaction), in memory. Run by
// `bun test` (this package's `test`).
import {describe, it, expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {migrate, createSQLStores} from '@missiv/server';
import {RemoteBunSQL} from '../src/remote-sql-bun/index.js';
import {storeContract} from '../../../packages/server/test/store-contract.js';

storeContract(
	{
		name: 'SQL on bun:sqlite',
		create: createSQLStores,
		async database() {
			const db = new RemoteBunSQL(new Database(':memory:', {strict: true}));
			await migrate(db);
			return db;
		},
	},
	{describe, it, expect},
);
