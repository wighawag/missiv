import {App} from './index.js';
import {hc} from 'hono/client';

// type checks only
async function main() {
	const client = hc<App>('http://localhost:34003/');

	const response = await client.api.user.register.$post({
		json: {
			domain: 'test',
			signature: '0x',
			address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		},
	});

	await client.api.private.sendMessage.$post({
		json: {
			domain: 'test',
			namespace: 'test',
			to: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
			message: 'hello world',
			messageType: 'clear',
			signature: '0xFAKE',
		},
	});

	await client.api.admin['db-reset'].$post({
		json: {
			reset: true,
		},
	});
}
