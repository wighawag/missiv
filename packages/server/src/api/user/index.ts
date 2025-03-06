import {Hono} from 'hono';
import {ServerOptions} from '../../types.js';
import {recoverMessageAddress} from 'viem';
import {
	ActionEditDomainUser,
	ActionGetCompleteUser,
	ActionGetMissivUser,
	ActionRegisterDomainUser,
	Address,
	originPublicKeyPublicationMessage,
} from 'missiv-common';
import {getAuth, setup} from '../../setup.js';
import {typiaValidator} from '@hono/typia-validator';
import {createValidate} from 'typia';
import {Env} from '../../env.js';

export function getUserAPI<Bindings extends Env>(options: ServerOptions<Bindings>) {
	const app = new Hono<{Bindings: Bindings}>()
		.use(setup({serverOptions: options}))
		.post('/register', typiaValidator('json', createValidate<ActionRegisterDomainUser>()), async (c) => {
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
				const message = originPublicKeyPublicationMessage(`https://${action.domain}`, publicKey as `0x${string}`);
				const addressRecovered = await recoverMessageAddress({
					message,
					signature: action.signature as `0x${string}`, // TODO typia fix for pattern and 0xstring
				});
				address = addressRecovered.toLowerCase();
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
		.post('/editUser', typiaValidator('json', createValidate<ActionEditDomainUser>()), async (c) => {
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
		.post('/getUser', typiaValidator('json', createValidate<ActionGetMissivUser>()), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const result = await storage.getUser(action.address);
			return c.json(result);
		})
		.post('/getCompleteUser', typiaValidator('json', createValidate<ActionGetCompleteUser>()), async (c) => {
			const config = c.get('config');
			const storage = config.storage;

			const action = c.req.valid('json');

			const result = await storage.getCompleteUser(action.domain, action.address);
			return c.json(result);
		});

	return app;
}
