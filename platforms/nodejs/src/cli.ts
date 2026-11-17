#!/usr/bin/env node
import 'named-logs-context';
import {serve} from '@hono/node-server';
import {createNodeServer, type NodeJSEnv} from './index.js';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {loadEnv} from 'ldenv';

const __dirname = import.meta.dirname;

loadEnv({
	defaultEnvFile: path.join(__dirname, '../.env.default'),
});

async function main() {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
	const program = new Command();

	program
		.name('missiv-server-nodejs')
		.version(pkg.version)
		.usage(`missiv-server-nodejs [--port 2000]  (env: DB, a libSQL URL, :memory: by default)`)
		.description('run missiv-server-nodejs as a node process')
		.option('-p, --port <port>');

	program.parse(process.argv);

	type Options = {
		port?: string;
	};

	const options: Options = program.opts();
	const port = options.port ? parseInt(options.port) : 2000;

	const env = process.env as NodeJSEnv;
	const {app, injectWebSocket} = await createNodeServer({db: env.DB || ':memory:', env});

	const server = serve({
		fetch: app.fetch,
		port,
	});
	injectWebSocket(server);

	console.log(`Server is running on http://localhost:${port}`);
}
main();
