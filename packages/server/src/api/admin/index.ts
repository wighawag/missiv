import {Hono} from 'hono';
import {Assert, IsZodExactly, ServerOptions} from '../../types.js';
import {setup} from '../../setup.js';
import {Env} from '../../env.js';
import {z} from 'zod';
import {zValidator} from '@hono/zod-validator';

type ResetAction = {reset: boolean};
const ResetActionSchema = z.object({
	reset: z.boolean(),
});
type ZodMatchResetAction = Assert<IsZodExactly<typeof ResetActionSchema, ResetAction>>;

export function getAdminAPI<Bindings extends Env>(options: ServerOptions<Bindings>) {
	const app = new Hono<{Bindings: Bindings}>()
		.use(setup({serverOptions: options}))
		.post('/db-reset', zValidator('json', ResetActionSchema), async (c) => {
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
