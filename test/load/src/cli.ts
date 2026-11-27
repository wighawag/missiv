// `pnpm load <scenario> [options]`: run a scenario against a missiv server and
// print its throughput and latency percentiles. See this package's README.
import os from 'node:os';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {v0_5} from './adapters/v0-5.js';
import type {AdapterFactory} from './adapters/types.js';
import {
	SCENARIOS,
	createWorld,
	fillHistory,
	runList,
	runRead,
	runRoom,
	runSend,
	type Parameters,
	type ScenarioName,
} from './scenarios.js';
import {formatSummary, type Summary} from './stats.js';
import {atURL, startBun, startNode, type RunningTarget} from './targets.js';

const ADAPTERS: Record<string, AdapterFactory> = {'0.5': v0_5};

const USAGE = `usage: pnpm load <${[...SCENARIOS, 'all'].join('|')}> [options]

  --target node|bun|url   where to send the load (default node)
                          node: the Node.js platform, started in a worker thread
                          bun:  the Bun platform, started as a child process
                          url:  a server already running at --url (wrangler dev, a deployment)
  --url <origin>          the server for --target url, e.g. http://127.0.0.1:34003
  --bun <path>            the bun executable (default: bun on PATH)
  --api <version>         the API adapter (default 0.5; available: ${Object.keys(ADAPTERS).join(', ')})
  --clients <n>           simulated users in send/read/list, one concurrent client each (default 20)
  --conversations <n>     conversations among them (default 20)
  --duration <s>          seconds each scenario runs (default 10)
  --history <n>           messages per conversation before read (default 100)
  --size <n>              characters per direct message (default 200)
  --room-size <n>         sockets in the room (default 100)
  --rate <n>              room messages per second (default 10)
  --json <file>           also write the run (parameters, machine, results) as JSON
`;

function fail(message: string): never {
	console.error(`${message}\n\n${USAGE}`);
	process.exit(2);
}

const {values, positionals} = parseArgs({
	allowPositionals: true,
	options: {
		target: {type: 'string', default: 'node'},
		url: {type: 'string'},
		bun: {type: 'string', default: 'bun'},
		api: {type: 'string', default: '0.5'},
		clients: {type: 'string', default: '20'},
		conversations: {type: 'string', default: '20'},
		duration: {type: 'string', default: '10'},
		history: {type: 'string', default: '100'},
		size: {type: 'string', default: '200'},
		'room-size': {type: 'string', default: '100'},
		rate: {type: 'string', default: '10'},
		json: {type: 'string'},
		help: {type: 'boolean', short: 'h'},
	},
});

if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

const scenario = positionals[0] as ScenarioName | 'all' | undefined;
if (!scenario || ![...SCENARIOS, 'all'].includes(scenario)) {
	fail(`a scenario is needed: ${[...SCENARIOS, 'all'].join(', ')}`);
}
const scenarios: ScenarioName[] = scenario === 'all' ? [...SCENARIOS] : [scenario];

function positive(name: string, value: string | undefined): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		fail(`--${name} must be a positive number, not ${value}`);
	}
	return n;
}

const parameters: Parameters = {
	clients: positive('clients', values.clients),
	conversations: positive('conversations', values.conversations),
	duration: positive('duration', values.duration),
	history: positive('history', values.history),
	size: positive('size', values.size),
	roomSize: positive('room-size', values['room-size']),
	rate: positive('rate', values.rate),
};
if (parameters.clients < 2) {
	fail(`--clients must be at least 2 (a conversation has two members)`);
}
if (parameters.conversations < Math.ceil(parameters.clients / 2)) {
	fail(`--conversations must be at least clients / 2, so that every client is in one`);
}

const adapterFactory = ADAPTERS[values.api!];
if (!adapterFactory) {
	fail(`no adapter for API ${values.api}`);
}

const log = (s: string) => console.error(s);

async function start(): Promise<RunningTarget> {
	switch (values.target) {
		case 'node':
			return startNode();
		case 'bun':
			return startBun(values.bun);
		case 'url':
			if (!values.url) {
				fail(`--target url needs --url`);
			}
			return atURL(values.url);
		default:
			fail(`unknown target ${values.target}`);
	}
}

async function main() {
	const target = await start();
	const results: Summary[] = [];
	let clientLoad = 0;
	try {
		log(`target ${target.name} at ${target.url}, API ${values.api}, scenarios ${scenarios.join(', ')}`);
		const adapter = adapterFactory({url: target.url});
		const elu = performance.eventLoopUtilization();

		/** run a scenario, adding the share of its time the server's thread was busy (node only) */
		async function measured(run: () => Promise<Summary[]>) {
			const before = await target.serverLoad?.();
			const summaries = await run();
			const after = await target.serverLoad?.();
			for (const summary of summaries) {
				if (before && after) {
					const active = after.active - before.active;
					const total = active + after.idle - before.idle;
					summary.extra = {...summary.extra, serverLoad: `${((active / total) * 100).toFixed(0)}%`};
				}
				results.push(summary);
				console.log(formatSummary(summary));
			}
		}

		const http = scenarios.filter((s) => s !== 'room');
		if (http.length) {
			const world = await createWorld(adapter, parameters, log);
			for (const name of http) {
				if (name === 'read') {
					await fillHistory(adapter, world, parameters, log);
				}
				log(`running ${name} for ${parameters.duration} s`);
				await measured(async () => [
					name === 'send'
						? await runSend(adapter, world, parameters)
						: name === 'read'
							? await runRead(adapter, world, parameters)
							: await runList(adapter, world, parameters),
				]);
			}
		}
		if (scenarios.includes('room')) {
			log(`running room: ${parameters.roomSize} sockets, ${parameters.rate} messages/s for ${parameters.duration} s`);
			await measured(() => runRoom(adapter, parameters, {loopback: target.loopback}, log));
		}

		clientLoad = performance.eventLoopUtilization(elu).utilization;
		console.log(`client event loop utilization: ${(clientLoad * 100).toFixed(0)}%`);
		if (clientLoad > 0.9) {
			log(`warning: the harness's own thread was saturated: these numbers are a bound on the client, not the server`);
		}
	} finally {
		await target.stop();
	}

	if (values.json) {
		const cpus = os.cpus();
		fs.writeFileSync(
			values.json,
			JSON.stringify(
				{
					date: new Date().toISOString(),
					target: target.name,
					url: target.name === 'url' ? target.url : undefined,
					api: values.api,
					parameters,
					machine: {
						cpu: cpus[0]?.model,
						cores: cpus.length,
						memoryGB: Math.round(os.totalmem() / 2 ** 30),
						platform: `${os.platform()} ${os.release()}`,
						node: process.version,
					},
					clientLoad,
					results,
				},
				null,
				2,
			),
		);
		log(`written to ${values.json}`);
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
