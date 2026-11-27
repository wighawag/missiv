// The store contract (`packages/server/test/store-contract.ts`) on Cloudflare's
// stores, on the Workers runtime: D1 for the KeyDirectory, a Conversation
// Durable Object per conversation and an Inbox Durable Object per (domain,
// user), called as the Worker's routes call them.
import {env} from 'cloudflare:test';
import {describe, it, expect} from 'vitest';
import {migrate} from '@missiv/server';
import {RemoteD1} from 'remote-sql-d1';
import {createCloudflareStores} from '../src/stores/index.js';
import type {CloudflareWorkerEnv} from '../src/env.js';
import {storeContract} from '../../../packages/server/test/store-contract.js';

let migrated: Promise<unknown> | undefined;

storeContract(
	{
		name: 'Durable Objects and D1 on the Workers runtime',
		async stores() {
			migrated ??= migrate(new RemoteD1(env.DB));
			await migrated;
			return createCloudflareStores(env as CloudflareWorkerEnv, new Map());
		},
	},
	{describe, it, expect},
);
