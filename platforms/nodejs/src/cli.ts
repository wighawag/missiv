#!/usr/bin/env node
import 'named-logs-context';
import {createServer, type Env} from 'missiv-server';
import {serve} from '@hono/node-server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {loadEnv} from 'ldenv';

const __dirname = import.meta.dirname;

loadEnv({
	defaultEnvFile: path.join(__dirname, '../.env.default'),
});

type NodeJSEnv = Env & {
	DB: string;
};

async function main() {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
	const program = new Command();

	program
		.name('missiv-server-nodejs')
		.version(pkg.version)
		.usage(`missiv-server-nodejs [--port 2000] [--sql <sql-folder>]`)
		.description('run missiv-server-nodejs as a node process')
		.option('-p, --port <port>');

	program.parse(process.argv);

	type Options = {
		port?: string;
	};

	const options: Options = program.opts();
	const port = options.port ? parseInt(options.port) : 2000;

	const env = process.env as NodeJSEnv;

	const db = env.DB;
	const TOKEN_ADMIN = (env as any).TOKEN_ADMIN;

	const client = createClient({
		url: db,
	});
	const remoteSQL = new RemoteLibSQL(client);

	const app = createServer<NodeJSEnv>({
		services: {
			getDB: () => remoteSQL,
			getRoom: () => {
				throw new Error(`getRoom not implemented for nodejs`);
			},
		},
		getEnv: () => env,
		upgradeWebSocket: () => {
			throw new Error(`upgradeWebSocket not implemented for nodejs`);
		},
	});

	if (db === ':memory:') {
		console.log(`executing setup...`);
		await app.fetch(
			new Request('http://localhost/admin/setup', {
				headers: {
					Authorization: `Basic ${btoa(`admin:${TOKEN_ADMIN}`)}`,
				},
			}),
		);
	}

	serve({
		fetch: app.fetch,
		port,
	});

	console.log(`Server is running on http://localhost:${port}`);
}
main();
