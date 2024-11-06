import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types.js';
import {setup} from '../../setup.js';
import {typiaValidator} from '@hono/typia-validator';
import {createValidate} from 'typia';

export function getAdminAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>()
		.use(setup({serverOptions: options}))
		.post('/db-reset', typiaValidator('json', createValidate<{reset: boolean}>()), async (c) => {
			const config = c.get('config');
			const env = config.env;
			const storage = config.storage;

			const action = c.req.valid('json');

			if (action.reset) {
				if (!(env as any).DEV) {
					throw new Error(`kv api not available unless in dev mode`);
				}
				await storage.reset();
				return c.json({success: true});
			}
			return c.json({success: false});
		});

	return app;
}
