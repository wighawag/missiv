import { CorsResponse } from '../cors';
import type { Env } from '../env';
import { Action, ActionSendMessage, Address, SchemaAction, SchemaAddress, parse } from '../types';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

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
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:0_unread:` });
	const unreadAccounts: { [account: Address]: number } = {};
	for (const key of unreadList.keys) {
		const splitted = key.name.split(':');
		const acccountFrom = splitted[splitted.length - 1] as Address;
		const messageTimestampMS = Number(splitted[splitted.length - 2]);
		unreadAccounts[acccountFrom] = messageTimestampMS;
	}
	const list = await env.MESSAGES.list({ prefix: `account:${account}:1_last:` });
	const accounts: { [account: Address]: { timestampMS: number; unread: boolean } } = {};
	const toRemove: { [key: string]: boolean } = {};
	for (const key of list.keys) {
		const splitted = key.name.split(':');
		const acccountFrom = splitted[splitted.length - 1] as Address;
		const messageTimestampMS = Number(splitted[splitted.length - 2]);
		if (!accounts[acccountFrom]) {
			const unread = unreadAccounts[acccountFrom];
			accounts[acccountFrom] = { timestampMS: unread ? Math.max(messageTimestampMS, unread) : messageTimestampMS, unread: !!unread };
		} else {
			toRemove[key.name] = true;
		}
	}

	for (const keyName of Object.keys(toRemove)) {
		await env.MESSAGES.delete(keyName);
	}
	const conversations: { account: Address; last: number; unread: boolean }[] = [];
	for (const account of Object.keys(accounts) as Address[]) {
		const data = accounts[account];
		const conversation = {
			account: account,
			last: data.timestampMS,
			unread: data.unread,
		};
		conversations.push(conversation);
	}
	return conversations;
}

export async function markAsRead(env: Env, account: Address, lastMessageTimestampMS: number) {
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:0_unread:` });
	let read = 0;
	for (const unreadKey of unreadList.keys) {
		const splitted = unreadKey.name.split(':');
		const timestamp = Number(splitted[splitted.length - 2]);
		if (timestamp <= lastMessageTimestampMS) {
			await env.MESSAGES.delete(unreadKey.name);
			read++;
		}
	}
	return { read };
}

export async function recordMessage(env: Env, account: Address, timestampMS: number, action: ActionSendMessage) {
	const chatMessageID = `message:${getChatID(action.to, account)}:${timestampMS}`;
	await env.MESSAGES.put(chatMessageID, JSON.stringify({ message: action.message, from: account }));
	await env.MESSAGES.put(`account:${action.to}:0_unread:${timestampMS}:${account}`, chatMessageID);
	await env.MESSAGES.put(`account:${action.to}:1_last:${timestampMS}:${account}`, chatMessageID);
}

export async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	if (request.method == 'POST') {
	} else {
		return new CorsResponse('Method not allowed', { status: 405 });
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
			return new CorsResponse('Not found', { status: 404 });
	}
}
