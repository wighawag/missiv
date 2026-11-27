import {Hono} from 'hono';
import {
	ActionEditDomainUserSchema,
	ActionGetDomainUserSchema,
	ActionGetKeySetSchema,
	ActionRegisterDomainUserSchema,
	RouteOptions,
} from '../../types.js';
import {keySetRef, recoverAccount} from 'delegated-identity';
import {isOriginOfDomain} from '@missiv/common';
import {refuseReplay, requireAccount, requireSigner, setup} from '../../setup.js';
import {Env} from '../../env.js';
import {MissivError, validateJSON} from '../../errors.js';
import {limitPerIP} from '../../rate-limit.js';

export function getUserAPI<CustomEnv extends Env>(options: RouteOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		// a registration charges the IP's budget (the one /session charges) before its signature is checked
		.use('/register', limitPerIP(options))
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
			await c.get('config').stores.keys.register(action.address, keyRef, Date.now(), action);
			return c.json({ok: true, message: 'Registered'} as const, 201);
		})
		.post('/editUser', validateJSON(ActionEditDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			const {account} = requireAccount(c, action.domain);
			await c.get('config').stores.keys.editUser(account, Date.now(), action);
			return c.json({ok: true, message: 'Edited'} as const);
		})
		.post('/getDomainUser', validateJSON(ActionGetDomainUserSchema), async (c) => {
			const action = c.req.valid('json');
			return c.json(await c.get('config').stores.keys.getDomainUser(action.domain, action.address));
		})
		.post('/getKeySet', validateJSON(ActionGetKeySetSchema), async (c) => {
			const action = c.req.valid('json');
			return c.json(await c.get('config').stores.keys.getKeySet(action.domain, action.keyRef));
		});

	return app;
}
