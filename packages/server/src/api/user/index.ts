import {Hono} from 'hono';
import {
	ActionEditDomainUserSchema,
	ActionGetDomainUserSchema,
	ActionRegisterDomainUserSchema,
	ServerOptions,
} from '../../types.js';
import {fromDomainToOrigin, recoverAccount} from 'delegated-identity';
import {requireAccount, requireSigner, setup} from '../../setup.js';
import {Env} from '../../env.js';
import {MissivError, validateJSON} from '../../errors.js';

export function getUserAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/register', validateJSON(ActionRegisterDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			const publicKey = requireSigner(c);

			let address: string;
			try {
				address = await recoverAccount({
					appOrigin: fromDomainToOrigin(action.domain),
					publicKey,
					ownershipSignature: action.signature,
				});
			} catch {
				throw new MissivError('invalid_request', 'malformed ownership signature');
			}
			if (address !== action.address) {
				throw new MissivError(
					'forbidden',
					`the ownership signature does not recover ${action.address} for domain ${action.domain}`,
				);
			}

			await c.get('config').storage.register(action.address, publicKey, action.signature, Date.now(), action);
			return c.json({ok: true, message: 'Registered'} as const, 201);
		})
		.post('/editUser', validateJSON(ActionEditDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').storage.editUser(account, Date.now(), action);
			return c.json({ok: true, message: 'Edited'} as const);
		})
		.post('/getDomainUser', validateJSON(ActionGetDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			return c.json(await c.get('config').storage.getDomainUser(action.domain, action.address));
		});

	return app;
}
