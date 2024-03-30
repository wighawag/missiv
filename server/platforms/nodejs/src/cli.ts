import {serve} from '@hono/node-server';
import {createServer} from 'missiv-server-app';

const app = createServer();

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
