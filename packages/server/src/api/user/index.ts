import {Hono} from 'hono';
import {
	ActionEditDomainUserSchema,
	ActionGetCompleteUserSchema,
	ActionGetMissivUserSchema,
	ActionRegisterDomainUserSchema,
	ServerOptions,
} from '../../types.js';
import {Address} from 'missiv-common';
import {fromDomainToOrigin, recoverAccount} from 'missiv-identity';
import {getAuth, setup} from '../../setup.js';
import {Env} from '../../env.js';
import {zValidator} from '@hono/zod-validator';

export function getUserAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.post('/register', zValidator('json', ActionRegisterDomainUserSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const env = config.env;

			const timestampMS = Date.now();
			const {publicKey} = getAuth(c);
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			const action = c.req.valid('json');

			let address: Address;
			if (action.signature === '0x0000000000000000000000000000000000000000000000000000000000000000') {
				if (!env.DEV) {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				address = action.address;
			} else {
				address = await recoverAccount({
					appOrigin: fromDomainToOrigin(action.domain),
					publicKey: publicKey as `0x${string}`,
					ownershipSignature: action.signature,
				});
				if (address != action.address) {
					throw new Error(
						`no matching address from signature for domain ${action.domain}: ${address} != ${action.address}`,
					);
				}
			}

			await storage.register(address, publicKey, timestampMS, action);
			return c.json(
				{
					ok: true,
					message: 'Registered',
				} as const,
				201,
			);
		})
		.post('/editUser', zValidator('json', ActionEditDomainUserSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;
			const env = config.env;

			const timestampMS = Date.now();
			const {account} = getAuth(c);
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			const action = c.req.valid('json');

			await storage.editUser(account, timestampMS, action);
			return c.json(
				{
					ok: true,
					message: 'Edited',
				} as const,
				201,
			);
		})
		.post('/getUser', zValidator('json', ActionGetMissivUserSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const result = await storage.getUser(action.address);
			return c.json(result);
		})
		.post('/getCompleteUser', zValidator('json', ActionGetCompleteUserSchema), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const result = await storage.getCompleteUser(action.domain, action.address);
			return c.json(result);
		});

	return app;
}
