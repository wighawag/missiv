import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';

// used to be hono Bindings but its type is now `object` which break compilation here
type Bindings = Record<string, any>;

export type SetupOptions<Env extends Bindings = Record<string, any>> = {
	serverOptions: ServerOptions<Env>;
};

export type Config = {
	storage: RemoteSQLStorage;
	env: Env;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config;
		env: Env;
	}
}

export function setup<Env extends Bindings = Bindings>(options: SetupOptions<Env>): MiddlewareHandler {
	const {getDB, getEnv} = options.serverOptions;

	return async (c, next) => {
		const env = getEnv(c);

		const db = getDB(c);
		const storage = new RemoteSQLStorage(db);

		c.set('config', {
			storage,
			env,
		});

		// auto setup
		if (c.req.query('_initDB') == 'true') {
			await storage.setup();
		}

		return next();
	};
}
