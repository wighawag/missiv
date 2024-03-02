import { UnstableDevWorker } from 'wrangler';
import {
	Action,
	ActionAcceptConversation,
	ActionGetMessages,
	ActionGetUser,
	ActionRegisterPublicKeys,
	ActionSendMessage,
	ResponseAcceptConversation,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseGetUser,
	ResponseRegisterPublicKeys,
	ResponseSendMessage,
} from '../src/types';

export type APIOptions = { signature: string } | { publicKey: string };

export class WorkerAPI {
	constructor(private worker: UnstableDevWorker) {}

	async call<T>(action: Action, options?: APIOptions): Promise<T> {
		const headers: { [header: string]: string } = {
			'content-type': 'application/json',
		};
		if (options) {
			headers.SIGNATURE = 'signature' in options ? options.signature : `FAKE:${options.publicKey}`;
		}
		const resp = await this.worker.fetch('api', {
			method: 'POST',
			body: JSON.stringify(action),
			headers,
		});
		if (resp.status !== 200) {
			throw new Error(await resp.text());
		}
		if (resp) {
			return (await resp.json()) as T;
		} else {
			throw new Error(`no response`);
		}
	}

	async register(action: Omit<ActionRegisterPublicKeys, 'type'>, options: APIOptions) {
		return this.call<ResponseRegisterPublicKeys>(
			{
				type: 'register',
				...action,
			},
			options,
		);
	}

	async sendMessage(action: Omit<ActionSendMessage, 'type'>, options: APIOptions) {
		return this.call<ResponseSendMessage>(
			{
				type: 'sendMessage',
				...action,
			},
			options,
		);
	}

	async getConversations(options: APIOptions) {
		return this.call<ResponseGetConversations>(
			{
				type: 'getConversations',
			},
			options,
		);
	}

	async getUnacceptedConversations(options: APIOptions) {
		return this.call<ResponseGetUnacceptedConversations>(
			{
				type: 'getUnacceptedConversations',
			},
			options,
		);
	}
	async acceptConversation(conversation: Omit<ActionAcceptConversation, 'type'>, options: APIOptions) {
		return this.call<ResponseAcceptConversation>(
			{
				type: 'acceptConversation',
				...conversation,
			},
			options,
		);
	}

	async getMessages(chat: Omit<ActionGetMessages, 'type'>, options: APIOptions) {
		return this.call<ResponseGetMessages>(
			{
				type: 'getMessages',
				...chat,
			},
			options,
		);
	}

	async getUser(chat: Omit<ActionGetUser, 'type'>) {
		return this.call<ResponseGetUser>({
			type: 'getUser',
			...chat,
		});
	}

	async clear() {
		return this.call<ResponseAcceptConversation>({
			type: 'db:reset',
		});
	}
}
