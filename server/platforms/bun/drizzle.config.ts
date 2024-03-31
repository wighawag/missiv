import type {Config} from 'drizzle-kit';
import * as dotenv from 'dotenv';
import {out, schema} from 'missiv-server-app/drizzle.config.json';
import {join} from 'path';
dotenv.config();

export default {
	out: join('../../app/', out),
	schema: join('../../app/', schema),
	driver: 'better-sqlite',
	dbCredentials: {
		url: 'sqlite.db',
	},
} satisfies Config;
