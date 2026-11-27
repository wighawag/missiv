// Where a load run sends its traffic: the Node.js platform (started by the
// harness, in a worker thread), the Bun platform (started by the harness, as a
// `bun` child process), or any URL (`wrangler dev`, a deployment) the harness
// does not start. Whatever the harness starts, it stops: `stop()` at the end of
// a run, and the process-exit hook below if the run ends any other way.
import {Worker} from 'node:worker_threads';
import {spawn, type ChildProcess} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type RunningTarget = {
	name: string;
	url: string;
	/** whether room sockets can each come from their own loopback address (see `sourceAddress`) */
	loopback: boolean;
	/** the server thread's busy and idle time so far (ms), where the harness can see it (node) */
	serverLoad?(): Promise<{idle: number; active: number}>;
	stop(): Promise<void>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** What is still running, so an exit that skips `stop()` (an error, Ctrl-C) still stops it. */
const running = new Set<{kill(): void}>();
process.on('exit', () => {
	for (const r of running) {
		r.kill();
	}
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		console.error(`\n${signal}: stopping what the harness started`);
		process.exit(130);
	});
}

export async function startNode(): Promise<RunningTarget> {
	const worker = new Worker(new URL('./node-server.ts', import.meta.url));
	const handle = {kill: () => void worker.terminate()};
	running.add(handle);
	const port = await new Promise<number>((resolve, reject) => {
		worker.once('message', (m: {port: number}) => resolve(m.port));
		worker.once('error', reject);
		worker.once('exit', (code) => reject(new Error(`node server exited (${code}) before listening`)));
	});
	return {
		name: 'node',
		url: `http://127.0.0.1:${port}`,
		loopback: true,
		serverLoad() {
			return new Promise((resolve) => {
				const listener = (m: {load?: {idle: number; active: number}}) => {
					if (m.load) {
						worker.off('message', listener);
						resolve(m.load);
					}
				};
				worker.on('message', listener);
				worker.postMessage('load');
			});
		},
		async stop() {
			running.delete(handle);
			await worker.terminate();
		},
	};
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const {port} = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** The Bun platform's CLI (`platforms/bun/src/cli.ts`) on a free port, on bun:sqlite in memory. */
export async function startBun(bun = 'bun'): Promise<RunningTarget> {
	const port = await freePort();
	const child = spawn(bun, ['src/cli.ts', '--port', String(port)], {
		cwd: path.join(repoRoot, 'platforms/bun'),
		// the rate limits raised out of reach, as the node target's (`node-server.ts`)
		env: {
			SESSION_SECRET: 'load-harness-session-secret',
			RATE_LIMIT_SEND_BURST: '1000000000',
			RATE_LIMIT_IP_BURST: '1000000000',
			...process.env,
			DB: ':memory:',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const handle = {kill: () => void child.kill('SIGKILL')};
	running.add(handle);
	let output = '';
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`bun did not start within 30 s:\n${output}`)), 30_000);
			child.once('error', (err) => {
				clearTimeout(timer);
				reject(new Error(`could not run ${bun} (pass --bun <path>): ${err.message}`));
			});
			child.once('exit', (code) => {
				clearTimeout(timer);
				reject(new Error(`bun exited (${code}) before listening:\n${output}`));
			});
			const onData = (data: Buffer) => {
				output += data.toString();
				if (output.includes('Server is running')) {
					clearTimeout(timer);
					resolve();
				}
			};
			child.stdout!.on('data', onData);
			child.stderr!.on('data', onData);
		});
	} catch (err) {
		running.delete(handle);
		child.kill('SIGKILL');
		throw err;
	}
	// keep draining its output so a chatty server never blocks on a full pipe
	child.stdout!.resume();
	child.stderr!.resume();
	return {
		name: 'bun',
		url: `http://127.0.0.1:${port}`,
		loopback: true,
		async stop() {
			child.kill('SIGTERM');
			if (!(await waitForExit(child, 5000))) {
				child.kill('SIGKILL');
				await waitForExit(child, 5000);
			}
			running.delete(handle);
		},
	};
}

/** A server the harness does not start (nor stop): `wrangler dev`, a deployment. */
export function atURL(url: string): RunningTarget {
	const {hostname} = new URL(url);
	return {
		name: 'url',
		url: url.replace(/\/$/, ''),
		loopback: hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.'),
		async stop() {},
	};
}
