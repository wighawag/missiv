export interface Env {
	WORKER_ENV?: 'dev';
	DB: D1Database;
	LIMITERS: DurableObjectNamespace;
	ROOMS: DurableObjectNamespace;
}
