// The server side of the socket heartbeat where the process holds the sockets
// (Node.js, Bun): `@missiv/common`'s heartbeat.ts. A client sends `ping` every
// interval; a socket that sent nothing for `HEARTBEAT_IDLE_INTERVALS` default
// intervals is closed, so dead clients do not accumulate. Cloudflare's objects
// answer `ping` by auto-response and close nothing as idle.
import {HEARTBEAT_IDLE_INTERVALS, HEARTBEAT_INTERVAL_MS} from '@missiv/common';

/** How long a socket may send nothing before Node.js and Bun close it (90 s). */
export const HEARTBEAT_IDLE_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_IDLE_INTERVALS;

export type IdleWatch = {
	/** the socket sent a frame: the idle time starts again */
	touch(): void;
	/** the socket closed: nothing to watch */
	stop(): void;
};

/** Call `onIdle` once when `touch` was not called for `idleMs` (default `HEARTBEAT_IDLE_MS`). */
export function watchIdle(onIdle: () => void, idleMs: number = HEARTBEAT_IDLE_MS): IdleWatch {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function arm() {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			if (!stopped) {
				stopped = true;
				onIdle();
			}
		}, idleMs);
	}
	arm();
	return {
		touch() {
			if (!stopped) {
				arm();
			}
		},
		stop() {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
