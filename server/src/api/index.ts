import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionSendMessage,
	Address,
	ComversationMessage,
	Conversation,
	ConversationRequest,
	ResponseGetConversations,
	ResponseGetMessages,
	SchemaAction,
	SchemaAddress,
	parse,
} from '../types';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

export function getChatID(accountA: Address, accountB: Address) {
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export async function getChatMessages(env: Env, accountA: Address, accountB: Address): Promise<ResponseGetMessages> {
	// TODO authenticate before
	// encrypted means it should be fine, but still
	const list = await env.MESSAGES.list({ prefix: `message:${getChatID(accountA, accountB)}:` });
	const values: ComversationMessage[] = [];
	for (const key of list.keys) {
		const value = await env.MESSAGES.get(key.name, 'json');
		values.push(value as ComversationMessage);
	}

	return values;
}
export async function getConversations(env: Env, account: Address): Promise<ResponseGetConversations> {
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:000_unread:` });
	const unreadAccounts: { [account: Address]: number } = {};
	for (const key of unreadList.keys) {
		const splitted = key.name.split(':');
		const acccountFrom = splitted[splitted.length - 1] as Address;
		const messageTimestampMS = Number(splitted[splitted.length - 2]);
		unreadAccounts[acccountFrom] = messageTimestampMS;
	}
	const list = await env.MESSAGES.list({ prefix: `account:${account}:100_last:` });
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
	const conversations: Conversation[] = [];
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
	const unreadList = await env.MESSAGES.list({ prefix: `account:${account}:000_unread:` });
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

export async function recordSentMessage(env: Env, account: Address, timestampMS: number, action: ActionSendMessage) {
	const conversationID = `conversation:${getChatID(action.to, account)}`;
	const existingConversation = await env.MESSAGES.get(conversationID);

	const chatMessageID = `message:${getChatID(action.to, account)}:${timestampMS}`;
	await env.MESSAGES.put(chatMessageID, JSON.stringify({ message: action.message, from: account }));

	if (!existingConversation) {
		await env.MESSAGES.put(`account:${action.to}:010_unaccepted:${timestampMS}:${account}`, chatMessageID);
	} else {
		await env.MESSAGES.put(`account:${action.to}:000_unread:${timestampMS}:${account}`, chatMessageID);
		await env.MESSAGES.put(`account:${action.to}:100_last:${timestampMS}:${account}`, chatMessageID);
	}

	// we also give the message to ourselves
	// TODO mark all as read before hand ?
	// + delete duplicate last
	await env.MESSAGES.put(`account:${account}:100_last:${timestampMS}:${action.to}`, chatMessageID);
}

export async function acceptConversation(env: Env, account: Address, action: ActionAcceptConversation) {
	const conversationID = `conversation:${getChatID(action.with, account)}`;
	const existingConversation = await env.MESSAGES.get(conversationID);

	if (!existingConversation) {
		await env.MESSAGES.put(conversationID, conversationID);
	}

	const unacceptedID = action.unacceptedID;
	const chatMessageID = await env.MESSAGES.get(unacceptedID);
	if (chatMessageID) {
		const splitted = chatMessageID.split(':');
		const messageTimestampMS = Number(splitted[splitted.length - 1]);
		await env.MESSAGES.delete(unacceptedID);
		// await env.MESSAGES.put(`account:${account}:000_unread:${messageTimestampMS}:${action.with}`, chatMessageID);
		await env.MESSAGES.put(`account:${account}:100_last:${messageTimestampMS}:${action.with}`, chatMessageID);

		return { deleted: 1 };
	}
	return { deleted: 0 };
}

export async function getConversationRequests(env: Env, account: Address): Promise<ConversationRequest[]> {
	const list = await env.MESSAGES.list({ prefix: `account:${account}:010_unaccepted:` });
	const accounts: { [account: Address]: { timestampMS: number; unacceptedID: string } } = {};
	const toRemove: { [key: string]: boolean } = {};
	const accountsAlreadyAccepted: { [key: string]: boolean } = {};
	for (const key of list.keys) {
		const splitted = key.name.split(':');
		const acccountFrom = splitted[splitted.length - 1] as Address;
		const messageTimestampMS = Number(splitted[splitted.length - 2]);
		const conversationID = `conversation:${getChatID(acccountFrom, account)}`;

		if (accountsAlreadyAccepted[acccountFrom]) {
			toRemove[key.name] = true;
		} else {
			const existingConversation = await env.MESSAGES.get(conversationID);
			if (existingConversation) {
				accountsAlreadyAccepted[acccountFrom] = true;
				toRemove[key.name] = true;
			} else {
				if (!accounts[acccountFrom]) {
					accounts[acccountFrom] = { timestampMS: messageTimestampMS, unacceptedID: key.name };
				} else {
					toRemove[key.name] = true;
				}
			}
		}
	}

	for (const keyName of Object.keys(toRemove)) {
		await env.MESSAGES.delete(keyName);
	}
	const conversationRequests: ConversationRequest[] = [];
	for (const account of Object.keys(accounts) as Address[]) {
		const data = accounts[account];
		const conversation = {
			account: account,
			timestampMS: data.timestampMS,
			id: data.unacceptedID,
		};
		conversationRequests.push(conversation);
	}
	return conversationRequests;
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

			await recordSentMessage(env, account, timestampMS, action);

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

		case 'getConversationRequests': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			const conversationRequests = await getConversationRequests(env, account);

			return toJSONResponse(conversationRequests);
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

			return toJSONResponse(getChatMessages(env, account, action.with));
		}
		case 'acceptConversation': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(acceptConversation(env, account, action));
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
