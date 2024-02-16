import type { Env } from '../env';
import { Action, ActionSendMessage, Address, SchemaAction, SchemaAddress, parse } from '../types';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new Response('Not Implemented', { status: 500 });

export function getChatID(accountA: Address, accountB: Address) {
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export async function getChatMessages(env: Env, accountA: Address, accountB: Address): Promise<Response> {
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
export async function getConversations(env: Env, account: Address) {
	const list = await env.MESSAGES.list({ prefix: `account:${account}:` });
	const values: { [key: string]: any } = {};
	const accounts: { [account: Address]: any } = {};
	for (const key of list.keys) {
		const splitted = key.name.split(':');
		const acccountFrom = splitted[splitted.length - 1] as Address;
		if (!accounts[acccountFrom]) {
			const value = await env.MESSAGES.get(key.name);
			values[key.name] = value;
			accounts[acccountFrom] = value;
		} else {
			// remove duplicate
			await env.MESSAGES.delete(key.name);
		}
	}
	return values;
}

export async function markAsRead(env: Env, account: Address, lastMessageTimestampMS: number) {
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:unread:` });
	let read = 0;
	for (const unreadKey of unreadList.keys) {
		const splitted = unreadKey.name.split(':');
		const timestamp = Number(splitted[splitted.length - 2]);
		if (timestamp <= lastMessageTimestampMS) {
			const value = await env.MESSAGES.get(unreadKey.name);
			if (value) {
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

export async function recordMessage(env: Env, account: Address, timestampMS: number, action: ActionSendMessage) {
	const chatMessageID = `message:${getChatID(action.to, account)}:${timestampMS}`;
	await env.MESSAGES.put(chatMessageID, JSON.stringify({ message: action.message, from: account }));
	await env.MESSAGES.put(`account:${action.to}:last:${timestampMS}:${account}`, chatMessageID);
	await env.MESSAGES.put(`account:${action.to}:unread:${timestampMS}:${account}`, chatMessageID);
}

export async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	if (request.method == 'POST') {
	} else {
		return new Response('Method not allowed', { status: 405 });
	}
	const rawContent = await request.text();
	console.log(rawContent);
	const action: Action = parse(SchemaAction, JSON.parse(rawContent));
	const timestampMS = Date.now();
	let account: Address | undefined;
	const authentication = request.headers.get('SIGNATURE');
	if (authentication) {
		if (authentication.startsWith('FAKE:')) {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`FAKE authentication only allowed in dev mode`);
			}
			account = parse(SchemaAddress, authentication.split(':')[1]);
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

			await recordMessage(env, account, timestampMS, action);

			return toJSONResponse({
				timestampMS,
			});
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const conversations = await getConversations(env, account);

			return toJSONResponse(conversations);
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
