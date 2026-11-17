import {Hono} from 'hono';
import {ActionResetSchema, ServerOptions} from '../../types.js';
import {setup} from '../../setup.js';
import {Env} from '../../env.js';
import {MissivError, validateJSON} from '../../errors.js';

export function getAdminAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/db-reset', validateJSON(ActionResetSchema), async (c) => {
			const config = c.get('config');
			const env = config.env;
			const storage = config.storage;

			const action = c.req.valid('json');

			if (action.reset) {
				if (!(env as any).DEV) {
					throw new MissivError('forbidden', 'db-reset is not available in this configuration');
				}
				await storage.reset();
				return c.json({success: true});
			}
			return c.json({success: false});
		});

	return app;
}
