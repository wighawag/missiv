import {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetMessages,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionSendMessage,
	Address,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetCompleteUser,
	ResponseGetConversations,
	ResponseGetDomainUser,
	ResponseGetMessages,
	ResponseGetMissivUser,
	ResponseGetUnacceptedConversations,
	ResponseSendMessage,
} from 'missiv-common';

export interface Storage {
	register(
		address: Address,
		publicKey: PublicKey,
		timestampMS: number,
		action: ActionRegisterDomainUser,
	): Promise<void>;
	editUser(address: Address, timestampMS: number, action: ActionEditDomainUser): Promise<void>;
	getMessages(address: Address, action: ActionGetMessages): Promise<ResponseGetMessages>;
	getUser(address: Address): Promise<ResponseGetMissivUser>;
	getCompleteUser(domain: string, address: Address): Promise<ResponseGetCompleteUser>;
	getCompleteUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetCompleteUser>;
	getDomainUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetDomainUser>;
	markAsRead(address: Address, action: ActionMarkAsRead): Promise<void>;
	sendMessage(
		publicKey: PublicKey,
		account: Address,
		timestampMS: number,
		action: ActionSendMessage,
	): Promise<ResponseSendMessage>;
	acceptConversation(
		account: Address,
		timestampMS: number,
		action: ActionAcceptConversation,
	): Promise<ResponseAcceptConversation>;
	getConversations(domain: string, namespace: string, address: Address): Promise<ResponseGetConversations>;
	getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetUnacceptedConversations>;
	getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetAcceptedConversations>;
	reset(): Promise<void>;
}
