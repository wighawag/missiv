import {Hono} from 'hono';
import {
	ActionEditDomainUserSchema,
	ActionGetCompleteUserSchema,
	ActionGetMissivUserSchema,
	ActionRegisterDomainUserSchema,
	ServerOptions,
} from '../../types.js';
import {recoverMessageAddress} from 'viem';
import {Address, fromDomainToOrigin, originPublicKeyPublicationMessage} from 'missiv-common';
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
				const message = originPublicKeyPublicationMessage(
					fromDomainToOrigin(action.domain),
					publicKey as `0x${string}`,
				);
				const addressRecovered = await recoverMessageAddress({
					message,
					signature: action.signature,
				});
				address = addressRecovered.toLowerCase() as `0x${string}`;
				if (address != action.address) {
					throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
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
