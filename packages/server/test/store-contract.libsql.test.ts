// The store contract on libSQL (the Node.js platform's database), in memory.
import {describe, it, expect} from 'vitest';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {migrate} from '../src/schema/migrate.js';
import {createSQLStores} from '../src/stores/sql/index.js';
import {storeContract} from './store-contract.js';

storeContract(
	{
		name: 'SQL on libSQL',
		create: createSQLStores,
		async database() {
			const db = new RemoteLibSQL(createClient({url: ':memory:'}));
			await migrate(db);
			return db;
		},
	},
	{describe, it, expect},
);
