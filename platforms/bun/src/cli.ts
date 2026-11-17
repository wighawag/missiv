#!/usr/bin/env bun
import 'named-logs-context';
import {createInProcessRooms, createServer, migrate} from 'missiv-server';
import {createBunWebSocket} from 'hono/bun';
import {Database} from 'bun:sqlite';
import {RemoteBunSQL} from './remote-sql-bun/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {loadEnv} from 'ldenv';
import {BunEnv} from './env.js';

const __dirname = import.meta.dirname;

loadEnv({
	defaultEnvFile: path.join(__dirname, '../.env.default'),
});

async function main() {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
	const program = new Command();

	program
		.name('missiv-server-bun')
		.version(pkg.version)
		.usage(`missiv-server-bun [--port 2000]  (env: DB, a sqlite path, :memory: by default)`)
		.description('run missiv-server-bun as a bun process')
		.option('-p, --port <port>');

	program.parse(process.argv);

	const options: {port?: string} = program.opts();
	const port = options.port ? parseInt(options.port) : 2000;

	const env = process.env as BunEnv;
	const db = new RemoteBunSQL(new Database(env.DB || ':memory:', {strict: true}));
	// the schema: the migrations this database has not had
	await migrate(db);

	const {upgradeWebSocket, websocket} = createBunWebSocket();
	const rooms = createInProcessRooms<BunEnv>({getDB: () => db});

	const app = createServer<BunEnv>({
		services: {getDB: () => db, getRoom: rooms.getRoom, getRateLimiter: rooms.getRateLimiter},
		inProcessRooms: {
			getRoom: rooms.getRoom,
			// TODO behind a proxy, a forwarded address once the proxy is trusted
			getIP: (c) =>
				(c.env as {requestIP?(r: Request): {address: string} | null} | undefined)?.requestIP?.(c.req.raw)?.address,
		},
		getEnv: () => env,
		upgradeWebSocket: upgradeWebSocket as any,
	});

	Bun.serve({port, fetch: app.fetch, websocket});
	console.log(`Server is running on :${port}`);
}

main();
