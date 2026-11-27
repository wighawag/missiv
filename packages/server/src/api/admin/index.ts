import {Hono} from 'hono';
import {ActionResetSchema, ServerOptions} from '../../types.js';
import {setup} from '../../setup.js';
import {Env} from '../../env.js';
import {MissivError, validateJSON} from '../../errors.js';
import {timingSafeEqual} from '../../utils/timing-safe-equal.js';
import {resetDatabase} from '../../schema/migrate.js';

export function getAdminAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.use(async (c, next) => {
			// every admin route needs `Authorization: Bearer <ADMIN_TOKEN>`, and none exists when it is unset
			const token = c.get('config').env.ADMIN_TOKEN;
			if (!token) {
				throw new MissivError('forbidden', 'the admin API is disabled (no ADMIN_TOKEN)');
			}
			const authorization = c.req.header('Authorization') || '';
			const given = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
			if (!timingSafeEqual(given, token)) {
				throw new MissivError('unauthenticated', 'a valid admin token is required');
			}
			return next();
		})
		.post('/db-reset', validateJSON(ActionResetSchema), async (c) => {
			const action = c.req.valid('json');
			if (action.reset) {
				await resetDatabase(options.services.getDB(c.get('config').env as CustomEnv));
				return c.json({success: true});
			}
			return c.json({success: false});
		});

	return app;
}
