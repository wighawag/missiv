// `pnpm test` here: the Bun platform's tests (`bun test`: the store contract on
// bun:sqlite, the platform's boot), which only bun can run. Without bun on PATH
// (or in $BUN) they are skipped with a warning naming what was not run, so a
// machine without bun still runs the rest of the repo's tests; set
// REQUIRE_BUN=1 (CI with bun) to make a missing bun a failure instead.
import {spawnSync} from 'node:child_process';

const bun = process.env.BUN || 'bun';
const probe = spawnSync(bun, ['--version'], {encoding: 'utf8'});
if (probe.error || probe.status !== 0) {
	const message = `@missiv/bun: bun not found (${bun}): the store contract on bun:sqlite and the Bun platform's boot were NOT run`;
	if (process.env.REQUIRE_BUN) {
		console.error(message);
		process.exit(1);
	}
	console.warn(`WARNING ${message}`);
	process.exit(0);
}
const result = spawnSync(bun, ['test'], {stdio: 'inherit'});
process.exit(result.status ?? 1);
