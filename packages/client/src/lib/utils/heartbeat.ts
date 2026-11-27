// The client side of every missiv socket's heartbeat (`@missiv/common`'s
// heartbeat.ts): a `ping` every interval, and the socket given up when no frame
// at all arrives within the timeout after one.
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_PING, HEARTBEAT_TIMEOUT_MS } from '@missiv/common';

export type Heartbeat = {
	/** a frame arrived (any frame): the socket is alive */
	received(): void;
	/** no more pings, no timeout */
	stop(): void;
};

/**
 * Start the heartbeat of an open socket: `send` a `ping` every `intervalMs`
 * (default 30 s), and call `onTimeout` once when nothing was `received` within
 * `timeoutMs` (default 10 s) of a ping. Stops itself on a timeout.
 */
export function startHeartbeat(params: {
	send(data: string): void;
	onTimeout(): void;
	intervalMs?: number;
	timeoutMs?: number;
}): Heartbeat {
	const intervalMs = params.intervalMs ?? HEARTBEAT_INTERVAL_MS;
	const timeoutMs = params.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const interval = setInterval(() => {
		try {
			params.send(HEARTBEAT_PING);
		} catch {
			// a socket that cannot send: the timeout gives it up
		}
		deadline ??= setTimeout(() => {
			stop();
			params.onTimeout();
		}, timeoutMs);
	}, intervalMs);

	function stop() {
		clearInterval(interval);
		if (deadline) clearTimeout(deadline);
		deadline = undefined;
	}

	return {
		received() {
			if (deadline) clearTimeout(deadline);
			deadline = undefined;
		},
		stop
	};
}
