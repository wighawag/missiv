import type { Env } from '../env';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new Response('Not Implemented', { status: 500 });

export type Action = { timestampMS: number } & (
	| { type: 'sendMessage'; to: `0x${string}`; message: string }
	| {
			type: 'getConversations';
	  }
	| { type: 'markAsRead'; lastMessageTimestampMS: number }
	| { type: 'kv:delete' }
	| { type: 'kv:list' }
	| { type: 'getMessages'; with: `0x${string}` }
);

export function getChatID(accountA: `0x${string}`, accountB: `0x${string}`) {
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export async function getChatMessages(env: Env, accountA: `0x${string}`, accountB: `0x${string}`): Promise<Response> {
	// TODO authenticate before
	// encrypted means it should be fine, but still
	const list = await env.MESSAGES.list({ prefix: `message:${getChatID(accountA, accountB)}:` });
	const values = [];
	for (const key of list.keys) {
		const value = await env.MESSAGES.get(key.name);
		values.push(value);
	}

	return toJSONResponse(values);
}

export async function markAsRead(env: Env, account: `0x${string}`, lastMessageTimestampMS: number) {
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:0_unread:` });
	let read = 0;
	for (const unreadKey of unreadList.keys) {
		const splitted = unreadKey.name.split(':');
		const timestamp = Number(splitted[splitted.length - 2]);
		if (timestamp <= lastMessageTimestampMS) {
			const value = await env.MESSAGES.get(unreadKey.name);
			if (value) {
				const readKey = unreadKey.name.replace('0_unread', '1_read');
				// TODO only put most recent, the unread/read list are just to keep track exising conversation
				//  they do not store messages
				await env.MESSAGES.put(readKey, value);
				await env.MESSAGES.delete(unreadKey.name);
				read++;
			}
		} else {
			// console.log({
			// 	timestamp,
			// 	lastMessageTimestampMS,
			// });
		}
	}
	return { read };
}

export async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	if (request.method == 'POST') {
	} else {
		return new Response('Method not allowed', { status: 405 });
	}
	const rawContent = await request.text();
	console.log(rawContent);
	const action: Action = JSON.parse(rawContent);
	const timestampMS = Date.now();
	let account: `0x${string}` | undefined;
	const authentication = request.headers.get('SIGNATURE');
	if (authentication) {
		if (authentication.startsWith('FAKE:')) {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`FAKE authentication only allowed in dev mode`);
			}
			account = authentication.split(':')[1] as `0x${string}`;
			if (!account) {
				throw new Error(`no account provided in FAKE mode`);
			}
		} else {
			// TODO
		}
	}

	switch (action.type) {
		case 'sendMessage': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			// TODO  validation

			const chatMessageID = `message:${getChatID(action.to, account)}:${timestampMS}`;
			await env.MESSAGES.put(chatMessageID, JSON.stringify({ message: action.message, from: account }));
			await env.MESSAGES.put(`account:${action.to}:0_unread:${timestampMS}:${account}`, chatMessageID);
			return toJSONResponse({
				timestampMS,
			});
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const list = await env.MESSAGES.list({ prefix: `account:${account}:` });
			const values: { [key: string]: any } = {};
			const accounts: { [account: `0x${string}`]: any } = {};
			for (const key of list.keys) {
				const splitted = key.name.split(':');
				const acccountFrom = splitted[splitted.length - 1] as `0x${string}`;
				if (!accounts[acccountFrom]) {
					// TODO TOlower case all account
					const value = await env.MESSAGES.get(key.name);
					values[key.name] = value;
					accounts[acccountFrom] = value;
				} else {
					// remove duplicate
					await env.MESSAGES.delete(key.name);
				}
			}

			return toJSONResponse(values);
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const { read } = await markAsRead(env, account, action.lastMessageTimestampMS);

			return toJSONResponse({ timestampMS, read });
		}
		case 'getMessages': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return getChatMessages(env, account, action.with);
		}
		case 'kv:list': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const list = await env.MESSAGES.list();
			const values: { [key: string]: any } = {};
			for (const key of list.keys) {
				const value = await env.MESSAGES.get(key.name);
				values[key.name] = value;
			}

			return toJSONResponse(values);
		}

		case 'kv:delete': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const list = await env.MESSAGES.list();
			for (const key of list.keys) {
				await env.MESSAGES.delete(key.name);
			}
			return toJSONResponse({ deleted: list.keys.length });
		}

		default:
			return new Response('Not found', { status: 404 });
	}
}
