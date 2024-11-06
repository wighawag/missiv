import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types.js';
import {recoverMessageAddress} from 'viem';
import {publicKeyAuthorizationMessage} from '../utils.js';
import {Address} from 'missiv-common';
import {getAuth, setup} from '../../setup.js';

export function getUserAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>()
		.use(setup({serverOptions: options}))
		.post(
			'/register',
			// TODO typia Validation
			// zValidator('json', SchemaActionRegisterDomainUser),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;
				const env = config.env;

				const timestampMS = Date.now();
				const {publicKey} = getAuth(c);
				if (!publicKey) {
					throw new Error(`no publicKey authenticated`);
				}

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				let address: Address;
				if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
					if (!env.DEV) {
						throw new Error(`FAKE authentication only allowed in dev mode`);
					}
					address = action.address;
				} else {
					const message = publicKeyAuthorizationMessage({address: action.address, publicKey});
					address = await recoverMessageAddress({
						message,
						signature: action.signature,
					});
					if (address.toLowerCase() != action.address.toLowerCase()) {
						throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
					}
				}

				address = address.toLowerCase() as Address;
				await storage.register(address, publicKey, timestampMS, action);
				return c.json(
					{
						ok: true,
						message: 'Registered',
					} as const,
					201,
				);
			},
		)
		.post(
			'/getUser',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetMissivUser),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getUser(action.address);
				return c.json(result);
			},
		)
		.post(
			'/getCompleteUser',
			// TODO typia Validation
			// zValidator('json', SchemaActionGetCompleteUser),
			async (c) => {
				const config = c.get('config');
				const storage = config.storage;

				// TODO typia Validation
				// const action = c.req.valid('json');
				const action = await c.req.json();

				const result = await storage.getCompleteUser(action.domain, action.address);
				return c.json(result);
			},
		);

	return app;
}
