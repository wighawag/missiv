import {createServer} from 'missiv-server';
import {createBunWebSocket} from 'hono/bun';
import { RemoteBunSQL } from './remote-sql-bun';
import Database from 'bun:sqlite';


// TODO env.DB
const db = new RemoteBunSQL(new Database(":memory:", { strict: true }));

export function getDB() {
	return db;
}
const {upgradeWebSocket, websocket} = createBunWebSocket();
const {app, handleWebsocket} = createServer({getDB});

app.get('/ws', upgradeWebSocket(handleWebsocket));

const port = 2000;

console.log(`running on :${port}`)

Bun.serve({
	fetch: app.fetch,
	websocket,
	port
});
