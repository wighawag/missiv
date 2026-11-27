/**
 * Session tokens (ADR-0004 decision 5, ADR-0006 "Sessions and replay").
 *
 * A token is `<payload>.<mac>`: `payload` the base64url of the JSON of
 * `{account, domain, keyRef, exp}` (`exp` in ms since the epoch), `mac` the
 * base64url of HMAC-SHA256 of `payload` (its base64url text, as JWT signs its
 * header and payload) under `SESSION_SECRET`. Checking one is an HMAC and a
 * constant-time comparison, with no signature check and no database read.
 *
 * Decisions recorded here (the format above is ADR-0006's; these are not):
 * - The MAC covers the base64url text, not the JSON re-serialised, so a check
 *   never depends on how a runtime orders or escapes JSON. Alternative: a MAC
 *   over canonical JSON; rejected as a second serialisation to keep identical.
 * - `exp` is in milliseconds, as every timestamp in missiv's API
 *   (`timestampMS`, `expiresAt`). Alternative: JWT's seconds; rejected for one
 *   unit across the API.
 * - HMAC runs in JS (`@noble/hashes`), synchronously, on every platform: a
 *   check is microseconds either way, and it needs no imported WebCrypto key per
 *   secret. Alternative: `crypto.subtle` HMAC; no measurable gain here.
 * - A token issued before a key replacement stays valid until it expires (at
 *   most `SESSION_LIFETIME_MS`): that is the price of no directory read per
 *   request, which ADR-0004 decision 5 chose. A new session can only be opened
 *   with the current key set.
 */
import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha256';
import type {Address, String0x} from '@missiv/common';
import {timingSafeEqual} from './utils/timing-safe-equal.js';

/** How long a session token is accepted: an hour (ADR-0006). */
export const SESSION_LIFETIME_MS = 60 * 60 * 1000;

/** What a session token says: who, in which domain, with which key set, until when. */
export type SessionClaims = {account: Address; domain: string; keyRef: String0x; exp: number};

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): string | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) {
		return undefined;
	}
	try {
		const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
		return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	} catch {
		return undefined;
	}
}

function macOf(payload: string, secret: string): string {
	return base64url(hmac(sha256, encoder.encode(secret), encoder.encode(payload)));
}

/** The token of `claims` under `secret`. */
export function signSessionToken(claims: SessionClaims, secret: string): string {
	const payload = base64url(
		encoder.encode(
			JSON.stringify({account: claims.account, domain: claims.domain, keyRef: claims.keyRef, exp: claims.exp}),
		),
	);
	return `${payload}.${macOf(payload, secret)}`;
}

/** Why a token was not accepted. */
export type SessionRefusal = 'invalid' | 'expired';

/**
 * The claims of `token` when its MAC is one of `secrets`' (the current secret,
 * then the previous one) and it has not expired at `now`; otherwise why not.
 */
export function verifySessionToken(
	token: string,
	secrets: string[],
	now: number,
): {ok: true; claims: SessionClaims} | {ok: false; reason: SessionRefusal} {
	const parts = token.split('.');
	if (parts.length !== 2) {
		return {ok: false, reason: 'invalid'};
	}
	const [payload, mac] = parts;
	// every secret is tried, so the time taken does not tell which one matched
	let matched = false;
	for (const secret of secrets) {
		matched = timingSafeEqual(mac, macOf(payload, secret)) || matched;
	}
	if (!matched) {
		return {ok: false, reason: 'invalid'};
	}
	const json = fromBase64url(payload);
	let claims: unknown;
	try {
		claims = json === undefined ? undefined : JSON.parse(json);
	} catch {
		claims = undefined;
	}
	if (!isClaims(claims)) {
		return {ok: false, reason: 'invalid'};
	}
	if (claims.exp <= now) {
		return {ok: false, reason: 'expired'};
	}
	return {ok: true, claims};
}

function isClaims(value: unknown): value is SessionClaims {
	const v = value as Partial<SessionClaims> | null;
	return (
		typeof v === 'object' &&
		v !== null &&
		typeof v.account === 'string' &&
		typeof v.domain === 'string' &&
		typeof v.keyRef === 'string' &&
		typeof v.exp === 'number' &&
		Number.isFinite(v.exp)
	);
}
