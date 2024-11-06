import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {MessagesStorage} from './storage/index.js';

// used to be hono Bindings but its type is now `object` which break compilation here
type Bindings = Record<string, any>;

export type SetupOptions<Env extends Bindings = Record<string, any>> = {
	serverOptions: ServerOptions<Env>;
};

export type Config = {
	storage: MessagesStorage;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config;
	}
}

export function setup<Env extends Bindings = Bindings>(options: SetupOptions<Env>): MiddlewareHandler {
	const {getDB, getEnv} = options.serverOptions;

	return async (c, next) => {
		const env = getEnv(c);

		const mnemonic: string = env.HD_MNEMONIC as string;
		if (!mnemonic) {
			throw new Error(`no HD_MNEMONIC defined`);
		}

		const db = getDB(c);
		const storage = new MessagesStorage(db);

		c.set('config', {
			storage,
		});

		// auto setup
		if (c.req.query('_initDB') == 'true') {
			await storage.setup();
		}

		return next();
	};
}
