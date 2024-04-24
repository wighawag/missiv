import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../../types';
import {recoverMessageAddress} from 'viem';
import {RemoteSQLStorage} from '../../storage/RemoteSQLStorage';
import {publicKeyAuthorizationMessage} from '../utils';
import {zValidator} from '@hono/zod-validator';
import {SchemaActionGetCompleteUser, SchemaActionGetMissivUser, SchemaActionRegisterDomainUser} from './types';
import {Address} from '../types';
import {eth_auth, getAuth} from '../auth';

export function getUserAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB} = options;

	const app = new Hono<{Bindings: Env & {}}>()
		.use(eth_auth({serverOptions: options}))
		.post('/register', zValidator('json', SchemaActionRegisterDomainUser), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const timestampMS = Date.now();
			const {publicKey} = getAuth(c);
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			const action = c.req.valid('json');

			let address: Address;
			if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
				if (c.env.WORKER_ENV !== 'dev') {
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
		})
		.post('/getUser', zValidator('json', SchemaActionGetMissivUser), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const action = c.req.valid('json');
			const result = await storage.getUser(action.address);
			return c.json(result);
		})
		.post('/getCompleteUser', zValidator('json', SchemaActionGetCompleteUser), async (c) => {
			const storage = new RemoteSQLStorage(getDB(c));
			const action = c.req.valid('json');
			const result = await storage.getCompleteUser(action.domain, action.address);
			return c.json(result);
		});

	return app;
}
