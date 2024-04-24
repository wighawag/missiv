import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types';
import {RemoteSQLStorage} from '../../storage/RemoteSQLStorage';
import {zValidator} from '@hono/zod-validator';
import {z} from 'zod';
import {eth_auth} from '../auth';

export function getAdminAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB} = options;

	const app = new Hono<{Bindings: Env & {}}>().use(eth_auth({serverOptions: options})).post(
		'/db-reset',
		zValidator(
			'json',
			z.object({
				reset: z.boolean(),
			}),
		),
		async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const action = c.req.valid('json');
			if (action.reset) {
				if (c.env.WORKER_ENV !== 'dev') {
					throw new Error(`kv api not available unless in dev mode`);
				}
				await storage.reset();
				return c.json({success: true});
			}
			return c.json({success: false});
		},
	);

	return app;
}
