// Which transports of the live inbox a deployment offers (`INBOX_TRANSPORTS`,
// ADR-0006 "Amendment: the inbox version and polling"): the socket (`GET
// /api/inbox/ws`), polling (`POST /api/inbox/changes`), or both (the default).
//
// Decisions recorded here:
// - Unset or empty means both, as a deployment that says nothing keeps today's
//   socket and gains polling. A value naming anything but `socket` and `poll`
//   (or naming neither) fails the request that reads it, as a malformed
//   RATE_LIMIT_* does: a typo would otherwise switch the live inbox off.
// - A transport that is off answers 404 `not_found` (the route does not exist
//   on this deployment), the socket's before any upgrade or token check, so a
//   client in `auto` sees a refused socket and polls.
import {INBOX_TRANSPORTS, type InboxTransport} from '@missiv/common';
import type {Env} from './env.js';
import {MissivError} from './errors.js';

export type InboxTransports = Record<InboxTransport, boolean>;

/** The transports `INBOX_TRANSPORTS` offers; throws for a value that names an unknown one, or none. */
export function inboxTransportsFromEnv(env: Env): InboxTransports {
	const value = env.INBOX_TRANSPORTS?.trim();
	if (!value) {
		return {socket: true, poll: true};
	}
	const named = value
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const unknown = named.filter((name) => !(INBOX_TRANSPORTS as readonly string[]).includes(name));
	if (unknown.length > 0 || named.length === 0) {
		throw new Error(`INBOX_TRANSPORTS must name ${INBOX_TRANSPORTS.join(' and/or ')}, not "${env.INBOX_TRANSPORTS}"`);
	}
	return {socket: named.includes('socket'), poll: named.includes('poll')};
}

/** 404 when `env` does not offer `transport`. */
export function requireInboxTransport(env: Env, transport: InboxTransport): void {
	if (!inboxTransportsFromEnv(env)[transport]) {
		throw new MissivError('not_found', `this server does not offer the live inbox's ${transport} transport`);
	}
}
