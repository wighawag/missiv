// What a direct message's push carries, as a contract apps route on.
//
// A push's `data.missiv` reaches an app's service worker where one runs. Where none
// does (Safari 18.4+ shows and clicks a Declarative Web Push message with no
// JavaScript, and a notification with `navigate` never fires `notificationclick`),
// only the `navigate` URL reaches the page, so the conversation also travels there:
// a hand-off, the LAST segment of the URL's fragment, `push-handoff=<base64url JSON>`.
// The hand-off is generic (keyed by service, `{missiv: ...}`), so another service
// pushing to the same app can use it and the app keeps one reader.
//
// Versioning: adding a field is compatible (the readers ignore unknown fields);
// renaming, removing or changing the meaning of one is a new `type` value.
import {z} from 'zod';

const MessageType = z.literal('message');

/**
 * `data.missiv` of a new direct message's push. `recipient` is the account it is
 * for: a device can be registered for several accounts, so the app checks it
 * against the account it is connected as before opening the conversation.
 */
export const MissivPushDataSchema = z.object({
	type: MessageType,
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
	messageID: z.string(),
	sender: z.string(),
	recipient: z.string(),
});
export type MissivPushData = z.infer<typeof MissivPushDataSchema>;

/**
 * The hand-off of a new direct message's push, under the key `missiv`: only what
 * routes (the URL ends up in the browser's history and in links a user shares, so
 * it carries references, never content; the app fetches the rest by id), and the
 * `recipient`, the account it is for, to check against the connected one.
 */
export const MissivPushHandoffSchema = z.object({
	type: MessageType,
	namespace: z.string(),
	conversationID: z.string(),
	recipient: z.string(),
});
export type MissivPushHandoff = z.infer<typeof MissivPushHandoffSchema>;

/** A push's `data.missiv`, checked: `undefined` unless it is one (unknown fields are ignored). */
export function readMissivPushData(data: unknown): MissivPushData | undefined {
	const parsed = MissivPushDataSchema.safeParse(data);
	return parsed.success ? parsed.data : undefined;
}

/** A hand-off's `missiv`, checked: `undefined` unless it is one (unknown fields are ignored). */
export function readMissivPushHandoff(value: unknown): MissivPushHandoff | undefined {
	const parsed = MissivPushHandoffSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** The fragment segment's name: `push-handoff=<base64url JSON>`. */
export const PUSH_HANDOFF_KEY = 'push-handoff';

function toBase64Url(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

/**
 * `url` with the hand-off as the last segment of its fragment: `#push-handoff=...`
 * when it has none (a URL ending in `#` counts as none), `#<fragment>&push-handoff=...`
 * when it has one. base64url has no `&` or `#`, so the segment always runs to the end.
 */
export function withPushHandoff(url: string, handoff: object): string {
	const segment = `${PUSH_HANDOFF_KEY}=${toBase64Url(JSON.stringify(handoff))}`;
	const hashIndex = url.indexOf('#');
	if (hashIndex === -1) {
		return `${url}#${segment}`;
	}
	if (hashIndex === url.length - 1) {
		return `${url}${segment}`;
	}
	return `${url}&${segment}`;
}

/**
 * Splits a hash (`location.hash` form: a leading `#`, or `''`) into its hand-off and
 * the rest. The hand-off is the text after the last `&` (or after the `#` when there
 * is no `&`) if it starts with `push-handoff=`; a malformed or non-object one is
 * `undefined`, never a throw. `hash` is what remains, with its leading `#`, or `''`
 * when nothing is left. A hash without a hand-off comes back as it was.
 */
export function splitPushHandoff(hash: string): {handoff: Record<string, unknown> | undefined; hash: string} {
	if (!hash.startsWith('#')) {
		return {handoff: undefined, hash};
	}
	const separator = hash.lastIndexOf('&');
	const start = separator === -1 ? 1 : separator + 1;
	const segment = hash.slice(start);
	const prefix = `${PUSH_HANDOFF_KEY}=`;
	if (!segment.startsWith(prefix)) {
		return {handoff: undefined, hash};
	}
	const rest = separator === -1 ? '' : hash.slice(0, separator);
	let handoff: Record<string, unknown> | undefined;
	try {
		const value: unknown = JSON.parse(fromBase64Url(segment.slice(prefix.length)));
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			handoff = value as Record<string, unknown>;
		}
	} catch {
		handoff = undefined;
	}
	return {handoff, hash: rest === '#' ? '' : rest};
}

/** What `consumePushHandoff` reads of `window.location`. */
export type PushHandoffLocation = {pathname: string; search: string; hash: string};
/** What `consumePushHandoff` uses of `window.history`. */
export type PushHandoffHistory = {state: unknown; replaceState(state: unknown, unused: string, url: string): void};

/**
 * For the page: reads the current URL's hand-off and, when there is one, removes it
 * at once (`replaceState`, keeping the path, the query, `history.state` and the rest
 * of the fragment), so a reload, a bookmark or a shared link never replays it. A
 * malformed hand-off is removed too, and gives `undefined`. Call
 * it on load BEFORE the app's router reads the URL, and on `hashchange` (registered
 * before the router's listener). Returns the whole hand-off: pass its `missiv` to
 * `readMissivPushHandoff`.
 */
export function consumePushHandoff(
	location: PushHandoffLocation = window.location,
	history: PushHandoffHistory = window.history,
): Record<string, unknown> | undefined {
	const split = splitPushHandoff(location.hash);
	if (split.hash === location.hash) {
		return undefined;
	}
	history.replaceState(history.state, '', location.pathname + location.search + split.hash);
	return split.handoff;
}
