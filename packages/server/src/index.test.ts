import {describe, expect, it} from 'vitest';
import {createServer} from '../src/index.js';

describe('createServer', () => {
	// a platform without WebSockets passes an upgradeWebSocket that throws when
	// called (nodejs did): building the app must not call it
	// (work/notes/observations/nodejs-platform-cannot-start.md)
	it('builds an app without calling upgradeWebSocket', () => {
		createServer({
			services: {
				getDB: () => {
					throw new Error('not used');
				},
				getRoom: () => {
					throw new Error('not used');
				},
				getRateLimiter: () => {
					throw new Error('not used');
				},
			},
			getEnv: () => ({}),
			upgradeWebSocket: () => {
				throw new Error('upgradeWebSocket called while building the app');
			},
		});
	});
});
