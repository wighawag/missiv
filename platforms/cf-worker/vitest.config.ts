// The cf-worker's tests run on the Workers runtime (workerd, through
// @cloudflare/vitest-pool-workers), with this platform's wrangler.toml: its
// Durable Objects (SQLite storage, alarms, hibernatable sockets) and its D1.
// One runtime with shared storage (`singleWorker`, no `isolatedStorage`): the
// pool cannot isolate the storage of Durable Objects that hold WebSockets
// (Cloudflare's "Known issues"), and every test keeps its data apart by fresh
// addresses, as the store contract does.
import {defineWorkersConfig} from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		include: ['test/**/*.test.ts'],
		poolOptions: {
			workers: {
				singleWorker: true,
				isolatedStorage: false,
				main: './src/worker.ts',
				wrangler: {configPath: './wrangler.toml'},
				miniflare: {
					bindings: {SESSION_SECRET: 'test-session-secret'},
				},
			},
		},
	},
});
