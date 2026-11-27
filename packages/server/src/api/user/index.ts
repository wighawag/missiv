import {Hono} from 'hono';
import {
	ActionEditDomainUserSchema,
	ActionGetDomainUserSchema,
	ActionGetKeySetSchema,
	ActionRegisterDomainUserSchema,
	ServerOptions,
} from '../../types.js';
import {keySetRef, recoverAccount} from 'delegated-identity';
import {isOriginOfDomain} from '@missiv/common';
import {refuseReplay, requireAccount, requireSigner, setup} from '../../setup.js';
import {Env} from '../../env.js';
import {MissivError, validateJSON} from '../../errors.js';

export function getUserAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		/**
		 * Register a key set: the request signed by its Ed25519 signing key, its
		 * ownership proof recovering the account for it and the app origin
		 * (delegated-identity's `recoverAccount`), the app origin one of the
		 * domain, and no replay of an accepted registration within its window (a
		 * replayed older one would make a replaced key set current again).
		 */
		.post('/register', validateJSON(ActionRegisterDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			const signingKey = requireSigner(c);
			if (!isOriginOfDomain(action.appOrigin, action.domain)) {
				throw new MissivError('invalid_request', `${action.appOrigin} is not an origin of ${action.domain}`);
			}
			if (action.keySet.signing.publicKey !== signingKey) {
				throw new MissivError('forbidden', `the request is not signed by the signing key of the key set`);
			}

			let address: string;
			try {
				address = await recoverAccount({
					appOrigin: action.appOrigin,
					keySet: action.keySet,
					ownershipSignature: action.ownershipSignature,
				});
			} catch {
				throw new MissivError('invalid_request', 'malformed ownership signature');
			}
			if (address !== action.address) {
				throw new MissivError(
					'forbidden',
					`the ownership signature does not recover ${action.address} for this key set and ${action.appOrigin}`,
				);
			}

			await refuseReplay(c);
			const keyRef = await keySetRef(action.keySet);
			await c.get('config').storage.register(action.address, keyRef, Date.now(), action);
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
		})
		.post('/getKeySet', validateJSON(ActionGetKeySetSchema), async (c) => {
			const action = c.req.valid('json');
			return c.json(await c.get('config').storage.getKeySet(action.domain, action.keyRef));
		});

	return app;
}
