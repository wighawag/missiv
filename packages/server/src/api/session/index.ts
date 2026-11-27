import {Hono} from 'hono';
import {ActionOpenSessionSchema, RouteOptions} from '../../types.js';
import {limitPerIP} from '../../rate-limit.js';
import {refuseReplay, requireSignedAccount, sessionSecrets, setup} from '../../setup.js';
import {Env} from '../../env.js';
import {validateJSON} from '../../errors.js';
import {SESSION_LIFETIME_MS, signSessionToken} from '../../session.js';
import type {ResponseOpenSession} from '@missiv/common';

export function getSessionAPI<CustomEnv extends Env>(options: RouteOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		// the IP's budget first: a refused request costs no signature check
		.use(limitPerIP(options))
		.use(setup({serverOptions: options}))
		/**
		 * Open a session (ADR-0006): a request signed by the signing key of the
		 * caller's current key set in the domain, never accepted twice within its
		 * window (a replay would hand out a second token), answered with a token
		 * for that account, domain and key set, signed with SESSION_SECRET.
		 */
		.post('/', validateJSON(ActionOpenSessionSchema), async (c) => {
			const action = c.req.valid('json');
			const [secret] = sessionSecrets(c.get('config').env);
			const {account, domainUser} = requireSignedAccount(c, action.domain);
			await refuseReplay(c);
			const expiresAt = Date.now() + SESSION_LIFETIME_MS;
			const token = signSessionToken(
				{account, domain: action.domain, keyRef: domainUser.keyRef, exp: expiresAt},
				secret,
			);
			return c.json({token, expiresAt, keyRef: domainUser.keyRef} satisfies ResponseOpenSession);
		});

	return app;
}
