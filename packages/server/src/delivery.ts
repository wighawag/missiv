// What follows a stored message or a changed inbox row: the live frames to the
// members' open sockets (`LiveInbox`, ADR-0006 "Live channel") and the Web Push
// to its recipient. Run after the response (`waitUntil` where the platform has
// one); a failure is logged, never the send's.
import type {Address, InboxServerFrame, Message} from '@missiv/common';
import type {Env} from './env.js';
import {pushNotifierFromEnv} from './push.js';
import type {AppendResult, ConversationKey, LiveInbox, Stores} from './stores/ports.js';
import type {ServerOptions} from './types.js';

/** The frames of one member after a change: the message (if any) and its inbox row, read only when it is online. */
async function framesOf(
	stores: Stores,
	live: LiveInbox,
	user: Address,
	key: ConversationKey,
	message?: Message,
): Promise<InboxServerFrame[]> {
	if (!(await live.isOnline(key.domain, user))) {
		return [];
	}
	const frames: InboxServerFrame[] = message ? [{type: 'message', message}] : [];
	const conversation = await stores.inbox.getConversation(user, key);
	if (conversation) {
		frames.push({type: 'conversation', conversation});
	}
	return frames;
}

/**
 * After an append: the message and each member's inbox row to the members'
 * sockets (the sender's included, for its other devices; not the member it is
 * hidden from), then the push to each `pushTo` recipient, unless
 * `PUSH_SKIP_WHEN_ONLINE` is `true` and the recipient has a socket open in the
 * domain. An inbox row is read only for a member who is online, so a send to
 * members with no socket costs no read more than before.
 */
export async function deliverAppended<CustomEnv extends Env>(
	options: ServerOptions<CustomEnv>,
	env: CustomEnv,
	stores: Stores,
	result: Extract<AppendResult, {status: 'appended'}>,
	members: {sender: Address; recipient: Address},
): Promise<void> {
	const {message} = result;
	const live = options.liveInbox;
	const tasks: Promise<unknown>[] = [];
	if (live) {
		const to = result.hiddenFrom === members.recipient ? [members.sender] : [members.sender, members.recipient];
		for (const user of to) {
			tasks.push(
				framesOf(stores, live, user, message, message).then((frames) =>
					frames.length > 0 ? live.publish(message.domain, user, frames) : undefined,
				),
			);
		}
	}

	const notifier = options.getPushNotifier ? options.getPushNotifier(env) : pushNotifierFromEnv(env);
	if (notifier) {
		const skipOnline = env.PUSH_SKIP_WHEN_ONLINE === 'true' && !!live;
		for (const to of result.pushTo) {
			tasks.push(
				(async () => {
					if (skipOnline && (await live!.isOnline(message.domain, to.address))) {
						return;
					}
					await notifier.notify({
						domain: message.domain,
						namespace: message.namespace,
						conversationID: message.conversationID,
						messageID: message.messageID,
						sender: members.sender,
						recipient: to.address,
						appOrigin: to.appOrigin,
					});
				})(),
			);
		}
	}
	const settled = await Promise.allSettled(tasks);
	for (const outcome of settled) {
		if (outcome.status === 'rejected') {
			console.error(`delivery failed`, outcome.reason);
		}
	}
}

/** After `accept`, `reject` or `markRead`: the user's inbox row to its own sockets (its other devices, its other stores). */
export async function deliverConversation<CustomEnv extends Env>(
	options: ServerOptions<CustomEnv>,
	stores: Stores,
	user: Address,
	key: ConversationKey,
): Promise<void> {
	const live = options.liveInbox;
	if (!live) {
		return;
	}
	try {
		const frames = await framesOf(stores, live, user, {
			domain: key.domain,
			namespace: key.namespace,
			conversationID: key.conversationID,
		});
		if (frames.length > 0) {
			await live.publish(key.domain, user, frames);
		}
	} catch (err) {
		console.error(`delivery failed`, err);
	}
}
