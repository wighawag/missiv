export type String0x = `0x${string}`;
export type PublicKey = String0x;
export type Address = String0x;
type ActionSendMessageBase = {
    type: 'sendMessage';
    domain: string;
    namespace: string;
    to: Address;
    message: string;
    signature: String0x;
};
export type ActionSendEncryptedMessage = ActionSendMessageBase & {
    toPublicKey: PublicKey;
    messageType: 'encrypted';
};
export type ActionSendInClearMessage = ActionSendMessageBase & {
    messageType: 'clear';
};
export type ActionSendMessage = ActionSendEncryptedMessage | ActionSendInClearMessage;
export type ResponseSendMessage = {
    timestampMS: number;
};
export type ActionAcceptConversation = {
    type: 'acceptConversation';
    domain: string;
    namespace: string;
    conversationID: string;
};
export type ResponseAcceptConversation = {
    timestampMS: number;
};
export type Conversation = {
    domain: string;
    namespace: string;
    first: Address;
    second: Address;
    conversationID: string;
    lastMessage: number;
    state: 'unaccepted' | 'unread' | 'read';
};
export type ActionGetConversations = {
    type: 'getConversations';
    domain: string;
    namespace: string;
};
export type ResponseGetConversations = {
    conversations: Conversation[];
};
export type ActionGetUnacceptedConversations = {
    type: 'getUnacceptedConversations';
    domain: string;
    namespace: string;
};
export type ResponseGetUnacceptedConversations = {
    unacceptedConversations: Conversation[];
};
export type ActionGetAcceptedConversations = {
    type: 'getAcceptedConversations';
    domain: string;
    namespace: string;
};
export type ResponseGetAcceptedConversations = {
    acceptedConversations: Conversation[];
};
export type ActionMarkAsRead = {
    type: 'markAsRead';
    domain: string;
    namespace: string;
    conversationID: string;
    lastMessageTimestampMS: number;
};
export type ResponseMarkAsRead = {
    timestampMS: number;
};
export type ConversationMessage = {
    id: number;
    donmain: string;
    namespace: string;
    conversationID: string;
    sender: Address;
    senderPublicKey: PublicKey;
    recipient: Address;
    recipientPublicKey: PublicKey;
    timestamp: number;
    message: string;
    type: 'encrypted' | 'clear';
    signature: string;
};
export type ActionGetMessages = {
    type: 'getMessages';
    domain: string;
    namespace: string;
    conversationID: string;
};
export type ResponseGetMessages = {
    messages: ConversationMessage[];
};
export type MissivUser = {
    address: Address;
    name: string;
    created: number;
};
export type ActionGetMissivUser = {
    type: 'getUser';
    address: Address;
};
export type ResponseGetMissivUser = {
    user: MissivUser | undefined;
};
export type DomainUser = {
    user: Address;
    domain: string;
    domainUsername: string;
    publicKey: PublicKey;
    signature: `0x${string}`;
    lastPresence: number;
    added: number;
};
export type ActionGetDomainUser = {
    type: 'getDomainUser';
    domain: string;
    address: Address;
};
export type ResponseGetDomainUser = {
    domainUser: DomainUser | undefined;
};
export type ActionRegisterDomainUser = {
    type: 'register';
    domain: string;
    signature: String0x;
    address: Address;
    name?: string;
    domainUsername?: string;
};
export type ResponseRegisterDomainUser = {
    timestampMS: number;
};
export type ActionGetCompleteUser = {
    domain: string;
    address: Address;
};
export type ResponseGetCompleteUser = {
    completeUser: (DomainUser & MissivUser) | undefined;
};
export type Action = ActionRegisterDomainUser | ActionSendMessage | ActionGetConversations | ActionGetUnacceptedConversations | ActionGetAcceptedConversations | ActionMarkAsRead | ActionGetMessages | ActionAcceptConversation | ActionGetMissivUser | ActionGetDomainUser | {
    type: 'db:select';
    table: string;
} | {
    type: 'db:reset';
};
export declare function getConversationID(accountA: Address, accountB: Address): string;
export declare function publicKeyAuthorizationMessage({ address, publicKey, }: {
    address: `0x${string}`;
    publicKey: `0x${string}`;
}): string;
export {};
