// The Inbox's live side held in process (Node.js, Bun): the open sockets of each
// (domain, user), as a Map. What a hibernatable Inbox Durable Object will give
// Cloudflare (task `cloudflare-durable-object-stores`), a Map gives one
// long-lived process. Several instances behind a load balancer would put a bus
// behind `LiveInbox` (publish to every instance, each delivering to its own
// sockets); none is built.
import type {Address, InboxServerFrame} from '@missiv/common';
import type {LiveConnection, LiveInboxHost} from './stores/ports.js';

/** The live inbox of one process: every socket it accepted, per (domain, user). */
export function createInProcessLiveInbox(): LiveInboxHost & {
	/** how many sockets are open, for tests and metrics */
	readonly size: number;
} {
	const connections = new Map<string, Set<LiveConnection>>();
	const keyOf = (domain: string, user: Address) => `${domain}\n${user.toLowerCase()}`;
	let size = 0;

	return {
		get size() {
			return size;
		},
		connect(domain, user, connection) {
			const key = keyOf(domain, user);
			let set = connections.get(key);
			if (!set) {
				set = new Set();
				connections.set(key, set);
			}
			if (!set.has(connection)) {
				set.add(connection);
				size++;
			}
			return () => {
				const current = connections.get(key);
				if (current?.delete(connection)) {
					size--;
					if (current.size === 0) {
						connections.delete(key);
					}
				}
			};
		},
		async publish(domain, user, frames: InboxServerFrame[]) {
			const set = connections.get(keyOf(domain, user));
			if (!set) {
				return;
			}
			const data = frames.map((frame) => JSON.stringify(frame));
			for (const connection of set) {
				for (const text of data) {
					try {
						connection.send(text);
					} catch (err) {
						// a socket closing as we send: its close removes it
						console.error(`live inbox: a send failed`, err);
					}
				}
			}
		},
		async isOnline(domain, user) {
			return (connections.get(keyOf(domain, user))?.size ?? 0) > 0;
		},
	};
}
