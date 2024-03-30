import {createServer, handleWebsocket} from 'missiv-server-app';
import {upgradeWebSocket} from 'hono/cloudflare-workers';

const app = createServer();

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
