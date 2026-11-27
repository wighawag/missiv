import {Hono} from 'hono';
import {ActionSendMessageSchema, RouteOptions} from '../../types.js';
import {charge} from '../../rate-limit.js';
import {requireAccount, setup} from '../../setup.js';
import {MissivError, validateJSON} from '../../errors.js';
import {
	keyRefsOfPairwiseKeyID,
	MESSAGE_ID_WINDOW_MS,
	ulidTime,
	verifyMessage,
	type ResponseSendMessage,
	type StaleDetails,
} from '@missiv/common';
import {pushNotifierFromEnv} from '../../push.js';
import {Env} from '../../env.js';
import {otherMemberOf} from '../conversation.js';

export function getMessagesAPI<CustomEnv extends Env>(options: RouteOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		/**
		 * Send a message (ADR-0006 "Sending"): the session token (HMAC, no read)
		 * names the sender's account and key set, which must be the message's
		 * `sender` and `senderKeyRef`; the message's signature must verify against
		 * that key set, which must still be the sender's current one (one directory
		 * read); its messageID's time must be within `MESSAGE_ID_WINDOW_MS` of the
		 * server's clock (else `stale`, with the server's time). Nothing is stored
		 * before all of that holds. Then one append (one transaction on SQL): a
		 * retry of a stored message answers its stored seq, the same messageID
		 * with another signature is `conflict`, and a message to a recipient who
		 * blocked the sender is acknowledged like any other and stored hidden
		 * from them. No request signature and no replay set: the messageID, inside
		 * its window and unique in the conversation, is the send's replay guard.
		 * Before any of it but the token, the account's send budget (a token
		 * bucket per account and domain, never per IP): beyond it `rate_limited`
		 * with the wait, so a flood costs no signature check and no read.
		 */
		.post('/send', validateJSON(ActionSendMessageSchema), async (c) => {
			const {message} = c.req.valid('json');
			const {account, keyRef} = requireAccount(c, message.domain);
			const {stores, env} = c.get('config');
			await charge(options.getTokenBuckets(env as CustomEnv).send, `${message.domain}:${account}`);

			if (message.sender !== account) {
				throw new MissivError('forbidden', 'the message is not from the account of the session');
			}
			if (message.senderKeyRef !== keyRef) {
				throw new MissivError('forbidden', 'the message names another key set than the session');
			}
			const recipient = otherMemberOf(message.conversationID, account);
			if (message.scheme === 'pairwise-v1' && !keyRefsOfPairwiseKeyID(message.keyID).includes(message.senderKeyRef)) {
				throw new MissivError('invalid_request', "a pairwise-v1 keyID names the sender's key set");
			}
			const now = Date.now();
			if (!(Math.abs(ulidTime(message.messageID) - now) <= MESSAGE_ID_WINDOW_MS)) {
				throw new MissivError('stale', 'the messageID is outside the accepted window: sign the message again', {
					serverTime: now,
				} satisfies StaleDetails);
			}
			// the sender's current key set (a token outlives a key replacement)
			const {domainUser} = await stores.keys.getDomainUser(message.domain, account);
			if (!domainUser || domainUser.keyRef !== message.senderKeyRef) {
				throw new MissivError('forbidden', "the message's key set is not the sender's current one");
			}
			if (!(await verifyMessage(message, domainUser.keySet.signing.publicKey))) {
				throw new MissivError('forbidden', "the message's signature does not verify against its sender's key set");
			}

			const result = await stores.conversations.append(message, {sender: account, recipient}, now);
			if (result.status === 'conflict') {
				throw new MissivError('conflict', 'another message is stored under this messageID');
			}
			if (result.status === 'appended') {
				// a store whose inboxes live elsewhere leaves their updates to us
				for (const update of result.pendingInboxUpdates) {
					await stores.inbox.update(update);
				}
				// a push to the recipient (not one who blocked the sender), after the
				// response, from the recipients the append loaded
				const notifier = options.getPushNotifier ? options.getPushNotifier(env as CustomEnv) : pushNotifierFromEnv(env);
				if (notifier && result.pushTo.length > 0) {
					const pushes = Promise.all(
						result.pushTo.map((to) =>
							notifier.notify({
								domain: message.domain,
								namespace: message.namespace,
								conversationID: message.conversationID,
								messageID: message.messageID,
								sender: account,
								recipient: to.address,
								appOrigin: to.appOrigin,
							}),
						),
					);
					const settled = pushes.catch((err) => console.error(`push failed`, err));
					if (options.waitUntil) {
						options.waitUntil(c, settled);
					}
				}
			}
			return c.json({
				seq: result.message.seq,
				serverTimestamp: result.message.serverTimestamp,
			} satisfies ResponseSendMessage);
		});

	return app;
}
