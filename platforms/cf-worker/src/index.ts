import {createServer} from 'missiv-server';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {wrapWithLogger} from './logging/index';

type Env = {
	DB: D1Database;
};

const {app, handleWebsocket} = createServer<Env>({getDB: (c) => c.env.DB, getEnv: (c) => c.env});

app.get('/ws', upgradeWebSocket(handleWebsocket));

const fetch = async (request: Request, env: Env, ctx: ExecutionContext) => {
	return wrapWithLogger(request, env, ctx, async () => app.fetch(request, env, ctx));
};

export default {
	fetch,
};
