import {createServer} from 'missiv-server';
import {upgradeWebSocket} from 'hono/cloudflare-workers';

type Env = {
	DB: D1Database;
};

const {app, handleWebsocket} = createServer<Env>({getDB: (c) => c.env.DB, getEnv: (c) => c.env});

app.get('/ws', upgradeWebSocket(handleWebsocket));

export default {
	fetch: app.fetch,
	// @ts-expect-error TS6133
	async scheduled(event, env, ctx) {
		ctx.waitUntil(() => {
			console.log(`scheduled`);
		});
	},
};
