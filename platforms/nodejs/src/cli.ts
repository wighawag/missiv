import {serve} from '@hono/node-server';
import {createServer} from 'missiv-server';

export function getDB() {
	// TODO
	return null as any;
}

const {app} = createServer({getDB, getEnv: (c) => process.env});
// TODO websocket ?

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
