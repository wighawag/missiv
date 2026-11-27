// A push notification when a direct message arrives, through push-notification-server
// (@push-notification/server): one POST /api/push per recipient, keyed so a retry
// never notifies twice, naming who wrote and nothing of what (a message's content
// is end-to-end encrypted, and the push service is not to see even a clear one).
import {withPushHandoff, type Address, type MissivPushData, type MissivPushHandoff} from '@missiv/common';
import type {Env} from './env.js';

/** A new message for `recipient`, from `sender`, in a conversation of `domain`. */
export type NewMessageNotification = {
	domain: string;
	namespace: string;
	conversationID: string;
	messageID: string;
	sender: Address;
	recipient: Address;
	/** the recipient's app origin, where the notification leads */
	appOrigin?: string;
};

export type PushNotifier = {
	notify(notification: NewMessageNotification): Promise<void>;
};

/** The idempotency key of a message's push to a recipient. */
export function pushKey(notification: {domain: string; messageID: string; recipient: Address}): string {
	return `missiv:${notification.domain}:${notification.messageID}:${notification.recipient}`;
}

/** `PUSH_TOKENS`: `<domain>=<token>,...`, the token push-notification-server issued for each domain. */
export function parsePushTokens(value: string | undefined): Map<string, string> {
	const tokens = new Map<string, string>();
	for (const entry of (value || '').split(',')) {
		const separator = entry.indexOf('=');
		if (separator > 0) {
			tokens.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
		}
	}
	return tokens;
}

/**
 * The Declarative Web Push message push-notification-server sends: the sender, never
 * the content. `navigate` is the app's root (never an app route) with the hand-off
 * as its fragment, for browsers where the app's service worker never runs (Safari
 * 18.4+); `data.missiv` is for the service worker where it does.
 */
export function pushMessage(notification: NewMessageNotification) {
	const sender = `${notification.sender.slice(0, 6)}...${notification.sender.slice(-4)}`;
	// key order fixed: the hand-off's encoding is pinned by a test vector
	const handoff: MissivPushHandoff = {
		type: 'message',
		namespace: notification.namespace,
		conversationID: notification.conversationID,
		recipient: notification.recipient,
	};
	const data: MissivPushData = {
		type: 'message',
		domain: notification.domain,
		namespace: notification.namespace,
		conversationID: notification.conversationID,
		messageID: notification.messageID,
		sender: notification.sender,
		recipient: notification.recipient,
	};
	return {
		web_push: 8030 as const,
		notification: {
			title: 'New message',
			body: `From ${sender}`,
			navigate: withPushHandoff(`${notification.appOrigin || `https://${notification.domain}`}/`, {missiv: handoff}),
			// one notification per conversation: a newer message replaces the older one
			tag: `missiv:${notification.conversationID}`,
			data: {missiv: data},
		},
	};
}

export type HTTPPushNotifierOptions = {
	/** push-notification-server's base URL */
	url: string;
	/** its token per domain */
	tokens: Map<string, string>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** how many times a push is retried after a failed send (502, a network error) or a busy key (409) */
	retries?: number;
	retryDelayMs?: number;
	log?: (message: string) => void;
};

/**
 * POST /api/push for each notification. 200 is done; 502 and a network error are
 * retried with the same key, 409 (the key is being sent) is retried later, each a
 * bounded number of times, then logged; 401 and 403 are a misconfiguration,
 * logged and never retried. A domain without a token sends nothing, logged once.
 */
export function createHTTPPushNotifier(options: HTTPPushNotifierOptions): PushNotifier {
	const fetchFunction = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const retries = options.retries ?? 3;
	const retryDelayMs = options.retryDelayMs ?? 1000;
	const log = options.log ?? ((message: string) => console.error(message));
	const endpoint = `${options.url.replace(/\/$/, '')}/api/push`;
	const domainsWithoutToken = new Set<string>();

	return {
		async notify(notification) {
			const token = options.tokens.get(notification.domain);
			if (!token) {
				if (!domainsWithoutToken.has(notification.domain)) {
					domainsWithoutToken.add(notification.domain);
					log(`push: no token for domain ${notification.domain} in PUSH_TOKENS, no push is sent for it`);
				}
				return;
			}
			const key = pushKey(notification);
			const body = JSON.stringify({
				address: notification.recipient,
				domain: notification.domain,
				message: pushMessage(notification),
				urgency: 'normal',
			});
			for (let attempt = 0; ; attempt++) {
				let status: number;
				try {
					const response = await fetchFunction(endpoint, {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							authorization: `Bearer ${token}`,
							'idempotency-key': key,
						},
						body,
					});
					status = response.status;
				} catch {
					status = 0; // the server could not be reached: as a failed send
				}
				if (status >= 200 && status < 300) {
					return;
				}
				if (status === 401 || status === 403) {
					log(`push: push-notification-server refused the token for ${notification.domain} (${status})`);
					return;
				}
				if (attempt >= retries || !(status === 0 || status === 409 || status >= 500)) {
					log(`push: ${key} not delivered (status ${status}, after ${attempt + 1} attempts)`);
					return;
				}
				await sleep(retryDelayMs * (attempt + 1));
			}
		},
	};
}

const notifiers = new Map<string, PushNotifier>();

/**
 * The notifier `PUSH_SERVER_URL` and `PUSH_TOKENS` configure (one per
 * configuration, so "logged once" holds across requests); none when the URL is unset.
 */
export function pushNotifierFromEnv(env: Env): PushNotifier | undefined {
	if (!env.PUSH_SERVER_URL) {
		return undefined;
	}
	const id = `${env.PUSH_SERVER_URL}|${env.PUSH_TOKENS || ''}`;
	let notifier = notifiers.get(id);
	if (!notifier) {
		notifier = createHTTPPushNotifier({url: env.PUSH_SERVER_URL, tokens: parsePushTokens(env.PUSH_TOKENS)});
		notifiers.set(id, notifier);
	}
	return notifier;
}
