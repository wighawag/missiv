import {createServer} from 'missiv-server-app';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {drizzle} from 'drizzle-orm/d1';

type Env = {
	DB: D1Database;
};

const {app, handleWebsocket} = createServer<Env>((c) => drizzle(c.env.DB));

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
