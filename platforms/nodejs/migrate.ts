import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
import {getDB} from './src/cli';

const args = process.argv.slice(2);
function main() {
	const db = getDB();
	migrate(db, {migrationsFolder: args[0]});
	process.exit(); // why this is needed ?
}
main();
