import type {CloudflareWorkerEnv} from '../src/env.js';

declare module 'cloudflare:test' {
	interface ProvidedEnv extends CloudflareWorkerEnv {}
}
