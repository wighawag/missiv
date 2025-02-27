import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {getPublicKey, utils as secpUtils} from '@noble/secp256k1';
import {publicKeyAuthorizationMessage} from 'missiv-common';
import {App, createServer} from 'missiv-server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient} from '@libsql/client';
import {API} from 'missiv-client';

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

export type TestUser = {
	delegatePublicKey: `0x${string}`;
	address: `0x${string}`;
	signatureForDelegation: `0x${string}`;
	delegatePrivateKey: Uint8Array;
};

export async function createUser(): Promise<TestUser> {
	const privateKey = generatePrivateKey();
	const account = privateKeyToAccount(privateKey);
	const delegatePrivateKey = secpUtils.randomPrivateKey();
	const delegatePublicKey = toHex(getPublicKey(delegatePrivateKey));
	const message = publicKeyAuthorizationMessage({
		address: account.address,
		publicKey: delegatePublicKey.toLowerCase(),
	});
	const user = {
		delegatePublicKey: delegatePublicKey.toLowerCase() as `0x${string}`,
		address: account.address.toLowerCase() as `0x${string}`,
		signatureForDelegation: (await account.signMessage({message: message})).toLowerCase() as `0x${string}`,
		delegatePrivateKey: delegatePrivateKey,
	} as const;

	return user;
}

export const USER_A = await createUser();
export const USER_B = await createUser();
export const USER_C = await createUser();

const dbCLient = createClient({url: ':memory:'});
const remoteSQL = new RemoteLibSQL(dbCLient);
const app = createServer({
	getDB() {
		return remoteSQL;
	},
	getEnv() {
		return {
			DEV: 'true',
		};
	},
	getRoom() {
		throw new Error(`no getRoom implemented in test`);
	},
	upgradeWebSocket() {
		// throw new Error(`no websocket implemented in test`);
		return (() => {}) as any;
	},
});

export const api = new API('http://localhost', {fetch: app.request as any}); // TODO type instead of any

export const FAKE_SIG = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Test utility functions

/**
 * Registers multiple test users with the API
 */
export async function setupTestUsers(users: TestUser[] = [USER_A, USER_B]) {
	await api.clear();

	for (const user of users) {
		await api.register(
			{
				type: 'register',
				address: user.address,
				signature: user.signatureForDelegation,
				domain: 'test.com',
			},
			{privateKey: user.delegatePrivateKey},
		);
	}
}

/**
 * Sends a test message between users
 * The sender is automatically included in the recipients list
 */
export async function sendMessage({
	from,
	to,
	content = 'Test message',
	conversationID = '1',
	messageType = 'clear',
	timestamp = Date.now(),
}: {
	from: TestUser;
	to: TestUser | TestUser[];
	content?: string;
	conversationID?: string;
	messageType?: 'clear' | 'encrypted';
	timestamp?: number;
}) {
	// Convert single recipient to array
	const recipients = Array.isArray(to) ? to : [to];

	// Ensure sender is included in recipients if not already
	const allRecipients = recipients.some((r) => r.address === from.address) ? recipients : [from, ...recipients];

	const messages = allRecipients.map((recipient) => ({
		content,
		to: recipient.address,
		signature: FAKE_SIG,
		toPublicKey: '0xff',
	}));

	return api.sendMessage(
		{
			type: 'sendMessage',
			domain: 'test.com',
			namespace: 'test',
			messages,
			messageType,
			conversationID,
			lastMessageReadTimestampMS: timestamp,
		},
		{publicKey: from.delegatePublicKey},
	);
}

export async function rejectConversation({from, conversationID}: {from: TestUser; conversationID: string}) {
	await api.rejectConversation(
		{
			type: 'rejectConversation',
			domain: 'test.com',
			namespace: 'test',
			conversationID,
		},
		{publicKey: from.delegatePublicKey},
	);
}

/**
 * Creates and returns a conversation between two users
 */
export async function createConversation({
	from,
	to,
	content = 'Initial message',
	conversationID = '1', // TODO need to be computed
}: {
	from: TestUser;
	to: TestUser;
	content?: string;
	conversationID?: string;
}) {
	await sendMessage({
		from,
		to,
		content,
		conversationID,
	});

	const {unacceptedConversations} = await api.getUnacceptedConversations(
		{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
		{publicKey: to.delegatePublicKey},
	);

	return unacceptedConversations[0].conversationID as string; // TODO why need to specify type
}

// /**
//  * Creates a conversation and automatically accepts it
//  */
// export async function createAndAcceptConversation({
// 	from,
// 	to,
// 	content = 'Initial message',
// 	conversationID = '1',
// 	timestamp = Date.now(),
// }: {
// 	from: TestUser;
// 	to: TestUser;
// 	content?: string;
// 	conversationID?: string;
// 	timestamp?: number;
// }) {
// 	const convId = await createConversation({from, to, content, conversationID});

// 	await api.acceptConversation(
// 		{
// 			type: 'acceptConversation',
// 			domain: 'test.com',
// 			namespace: 'test',
// 			conversationID: convId,
// 			lastMessageReadTimestampMS: timestamp,
// 		},
// 		{publicKey: to.delegatePublicKey},
// 	);

// 	return convId;
// }

export async function acceptConversation({
	user,
	conversationID,
	timestamp = Date.now(),
}: {
	user: TestUser;
	conversationID: string;
	timestamp?: number;
}) {
	await api.acceptConversation(
		{
			type: 'acceptConversation',
			domain: 'test.com',
			namespace: 'test',
			conversationID,
			lastMessageReadTimestampMS: timestamp,
		},
		{publicKey: user.delegatePublicKey},
	);
}

/**
 * Gets messages in a conversation
 */
export async function getMessages(user: TestUser, conversationID: string) {
	const {messages} = await api.getMessages(
		{
			type: 'getMessages',
			domain: 'test.com',
			namespace: 'test',
			conversationID,
		},
		{publicKey: user.delegatePublicKey},
	);

	return messages;
}

/**
 * Returns parsed message contents from a conversation
 */
export async function getMessageContents(user: TestUser, conversationID: string) {
	const messages = await getMessages(user, conversationID);
	return messages.map((m) => JSON.parse(m.message).content);
}

/**
 * Gets accepted conversations for a user
 */
export async function getAcceptedConversations(user: TestUser) {
	const {acceptedConversations} = await api.getAcceptedConversations(
		{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
		{publicKey: user.delegatePublicKey},
	);

	return acceptedConversations;
}

/**
 * Gets unaccepted conversations for a user
 */
export async function getUnacceptedConversations(user: TestUser) {
	const {unacceptedConversations} = await api.getUnacceptedConversations(
		{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
		{publicKey: user.delegatePublicKey},
	);

	return unacceptedConversations;
}
