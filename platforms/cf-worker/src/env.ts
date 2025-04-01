import {Env} from 'missiv-server';

export type CloudflareWorkerEnv = Env & {
	DB: D1Database;
	ROOMS: DurableObjectNamespace;
	LIMITERS: DurableObjectNamespace;
	LOGFLARE_API_KEY?: string;
	LOGFLARE_SOURCE?: string;
	NAMED_LOGS?: string;
	NAMED_LOGS_LEVEL?: string;
};
