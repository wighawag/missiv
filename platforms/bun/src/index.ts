import {createServer} from 'missiv-server';
import {createBunWebSocket} from 'hono/bun';

export function getDB() {
	// TODO
	return null as any;
}
const {upgradeWebSocket, websocket} = createBunWebSocket();
const {app, handleWebsocket} = createServer({getDB});

app.get('/ws', upgradeWebSocket(handleWebsocket));

Bun.serve({
	fetch: app.fetch,
	websocket,
});
