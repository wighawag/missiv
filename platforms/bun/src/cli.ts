#!/usr/bin/env bun
import 'named-logs-context';
import {createBunServer} from './server.js';
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
		.name('missiv-bun')
		.version(pkg.version)
		.usage(`missiv-bun [--port 2000]  (env: DB, a sqlite path, :memory: by default)`)
		.description('run missiv on bun')
		.option('-p, --port <port>');

	program.parse(process.argv);

	const options: {port?: string} = program.opts();
	const port = options.port ? parseInt(options.port) : 2000;

	const env = process.env as BunEnv;
	const {app, websocket} = await createBunServer({db: env.DB || ':memory:', env});

	Bun.serve({port, fetch: app.fetch, websocket});
	console.log(`Server is running on :${port}`);
}

main();
