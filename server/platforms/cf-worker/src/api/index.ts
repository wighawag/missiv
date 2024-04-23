import { keccak_256 } from '@noble/hashes/sha3';
import { Signature, verify as verifySignature } from '@noble/secp256k1';
import { recoverMessageAddress } from 'viem';
import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionSendMessage,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseSendMessage,
	SchemaAction,
	SchemaPublicKey,
	parse,
	Address,
	SchemaAddress,
	ResponseGetMissivUser,
	ResponseGetDomainUser,
	ResponseGetUnacceptedConversations,
	ResponseGetAcceptedConversations,
	publicKeyAuthorizationMessage,
	ActionGetMessages,
} from 'missiv';
import { toJSONResponse } from '../utils';
import { Storage } from './Storage';
import { D1Storage } from './D1Storage';

export async function register(
	storage: Storage,
	address: Address,
	publicKey: PublicKey,
	timestampMS: number,
	action: ActionRegisterDomainUser,
) {
	await storage.register(address, publicKey, timestampMS, action);
}

export async function getMessages(storage: Storage, action: ActionGetMessages): Promise<ResponseGetMessages> {
	return storage.getMessages(action);
}

export async function getUser(storage: Storage, address: Address): Promise<ResponseGetMissivUser> {
	return storage.getUser(address);
}

export async function getDomainUser(storage: Storage, domain: string, address: Address): Promise<ResponseGetDomainUser> {
	return storage.getDomainUser(domain, address);
}

export async function getUserAddressByPublicKey(storage: Storage, publicKey: PublicKey): Promise<ResponseGetDomainUser> {
	return storage.getUserAddressByPublicKey(publicKey);
}

export async function markAsRead(storage: Storage, publicKey: PublicKey, action: ActionMarkAsRead) {
	await storage.markAsRead(publicKey, action);
}

export async function sendMessage(
	storage: Storage,
	publicKey: PublicKey,
	account: Address,
	timestampMS: number,
	action: ActionSendMessage,
): Promise<ResponseSendMessage> {
	return storage.sendMessage(publicKey, account, timestampMS, action);
}

export async function acceptConversation(
	storage: Storage,
	account: Address,
	timestampMS: number,
	action: ActionAcceptConversation,
): Promise<ResponseAcceptConversation> {
	return storage.acceptConversation(account, timestampMS, action);
}

export async function getConversations(
	storage: Storage,
	domain: string,
	namespace: string,
	address: Address,
): Promise<ResponseGetConversations> {
	return storage.getConversations(domain, namespace, address);
}

export async function getUnacceptedConversations(
	storage: Storage,
	domain: string,
	namespace: string,
	account: Address,
): Promise<ResponseGetUnacceptedConversations> {
	return storage.getUnacceptedConversations(domain, namespace, account);
}

export async function getAcceptedConversations(
	storage: Storage,
	domain: string,
	namespace: string,
	account: Address,
): Promise<ResponseGetAcceptedConversations> {
	return storage.getAcceptedConversations(domain, namespace, account);
}

export async function handleComversationsApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	const storage = new D1Storage(env.DB);

	if (request.method == 'POST') {
	} else {
		return new CorsResponse('Method not allowed', { status: 405 });
	}
	const rawContent = await request.text();
	const action: Action = parse(SchemaAction, JSON.parse(rawContent));
	const timestampMS = Date.now();
	let publicKey: PublicKey | undefined;
	let account: Address | undefined;

	const authentication = request.headers.get('SIGNATURE');
	if (authentication) {
		if (authentication.startsWith('FAKE:')) {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`FAKE authentication only allowed in dev mode`);
			}
			const splitted = authentication.split(':');
			publicKey = parse(SchemaPublicKey, splitted[1]);
			if (!publicKey) {
				throw new Error(`no publicKey provided in FAKE mode`);
			}
		} else {
			const signatureString = authentication;
			const splitted = signatureString.split(':');
			const recoveryBit = Number(splitted[1]);
			const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
			const msgHash = keccak_256(rawContent);
			const recoveredPubKey = signature.recoverPublicKey(msgHash);
			publicKey = `0x${recoveredPubKey.toHex()}`;
		}

		const response = await env.DB.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();

		if (response.results.length >= 1) {
			const domainUser = response.results[0];
			if ('domain' in action) {
				if (domainUser.domain != action.domain) {
					throw new Error(`the publicKey belongs to domain "${domainUser.domain}" and not "${action.domain}"`);
				}
			}

			account = parse(SchemaAddress, domainUser.user);
		}
	}

	switch (action.type) {
		case 'register': {
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			let address: Address;
			if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
				if (env.WORKER_ENV !== 'dev') {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				address = action.address;
			} else {
				const message = publicKeyAuthorizationMessage({ address: action.address, publicKey });
				address = await recoverMessageAddress({
					message,
					signature: action.signature,
				});
				if (address.toLowerCase() != action.address.toLowerCase()) {
					throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
				}
			}

			address = address.toLowerCase() as Address;
			await register(storage, address, publicKey, timestampMS, action);
			return toJSONResponse({ success: true });
		}

		case 'sendMessage': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			return toJSONResponse(sendMessage(storage, publicKey, account, timestampMS, action));
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getConversations(storage, action.domain, action.namespace, account));
		}

		case 'getAcceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getAcceptedConversations(storage, action.domain, action.namespace, account));
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getUnacceptedConversations(storage, action.domain, action.namespace, account));
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(markAsRead(storage, account, action));
		}
		case 'getMessages': {
			return toJSONResponse(getMessages(storage, action));
		}
		case 'getUser': {
			return toJSONResponse(getUser(storage, action.address));
		}
		case 'getDomainUser': {
			return toJSONResponse(getDomainUser(storage, action.domain, action.address));
		}
		case 'acceptConversation': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(acceptConversation(storage, account, timestampMS, action));
		}
		case 'db:select': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const table = action.table;
			const SQL_SELECT = env.DB.prepare('SELECT * FROM ?1');
			const { results } = await SQL_SELECT.bind(table).all();
			return toJSONResponse(results);
		}

		case 'db:reset': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			await storage.reset();
			return toJSONResponse({ success: true });
		}

		default:
			return new CorsResponse('Not found', { status: 404 });
	}
}
