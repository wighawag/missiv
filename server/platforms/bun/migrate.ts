import {migrate} from 'drizzle-orm/bun-sqlite/migrator';
import {getDB} from './src';

const args = process.argv.slice(2);
function main() {
	const db = getDB();
	migrate(db, {migrationsFolder: args[0]});
	process.exit(); // why this is needed ?
}
main();
