/** not considered it seems, so we use tags
 * @Pattern /^0x[a-f0-9]+$/
 */
export type String0x = `0x${string}`; // & tags.Pattern<'^0x[a-f0-9]+$'>;

export type PublicKey = String0x;

export type Address = String0x;

type ActionSendMessageBase = {
	type: 'sendMessage';
	domain: string;
	namespace: string;
	conversationID: string;
	lastMessageReadTimestampMS: number;
	messages: {to: Address; toPublicKey: PublicKey; content: string}[];
	signature: String0x;
};

export type ActionSendEncryptedMessage = ActionSendMessageBase & {
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
	lastMessageReadTimestampMS: number;
};
export type ResponseAcceptConversation = {
	timestampMS: number;
};

export type Conversation = {
	domain: string;
	namespace: string;
	user: Address;
	conversationID: string;
	members: Address[];
	lastMessage: number;
	lastRead: number;
	accepted: boolean; // TODO enum (notAccepted | accepted  | rejected)
};

export type ActionGetConversations = {
	type: 'getConversations';
	domain: string;
	namespace: string;
};
export type ResponseGetConversations = {conversations: Conversation[]};

export type ActionGetUnacceptedConversations = {
	type: 'getUnacceptedConversations';
	domain: string;
	namespace: string;
};
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]};

export type ActionGetAcceptedConversations = {
	type: 'getAcceptedConversations';
	domain: string;
	namespace: string;
};
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]};

export type ActionMarkAsRead = {
	type: 'markAsRead';
	domain: string;
	namespace: string;
	conversationID: string;
	lastMessageReadTimestampMS: number;
};
export type ResponseMarkAsRead = {success: boolean};

export type ActionRejectConversation = {
	type: 'rejectConversation';
	domain: string;
	namespace: string;
	conversationID: string;
};

export type ResponseRejectConversation = {success: boolean};

// domain TEXT NOT NULL,
// namespace TEXT NOT NULL,
// conversationID TEXT NOT NULL,
// messageID INTEGER NOT NULL, -- shared id
// recipient TEXT NOT NULL, -- recipient of the message (includes sender too)
// -----------------------------------------------------------------------------------------------

// sender TEXT NOT NULL, -- sender of the message
// -- TODO : senderPublicKey
// message TEXT NOT NULL, -- should be encrypted // {}
// timestamp TIMESTAMP NOT NULL,
export type ConversationMessage = {
	domain: string;
	namespace: string;
	conversationID: string;
	id: number;
	recipient: Address;
	sender: Address;
	senderPublicKey: PublicKey;
	recipientPublicKey: PublicKey;
	content: string;
	timestamp: number;
	messageType: 'encrypted' | 'clear';
};

export type ActionGetMessages = {
	type: 'getMessages';
	domain: string;
	namespace: string;
	conversationID: string;
};
export type ResponseGetMessages = {messages: ConversationMessage[]};

export type MissivUser = {
	address: Address;
	name: string;
	created: number;
};
export type ActionGetMissivUser = {
	type: 'getUser';
	address: Address;
};
export type ResponseGetMissivUser = {user: MissivUser | undefined};

export type DomainUser = {
	user: Address;
	domain: string;
	domainUsername: string;
	publicKey: PublicKey;
	signature: String0x;
	lastPresence: number;
	added: number;
};
export type ActionGetDomainUser = {
	type: 'getDomainUser';
	domain: string;
	address: Address;
};
export type ResponseGetDomainUser = {domainUser: DomainUser | undefined};

export type ActionRegisterDomainUser = {
	type: 'register';
	domain: string;
	signature: String0x;
	address: Address;
	name?: string;
	domainUsername?: string;
	description?: string;
	domainDescription?: string;
};

export type ActionEditDomainUser = {
	type: 'editUser';
	domain: string;
	name?: string;
	domainUsername?: string;
	description?: string;
	domainDescription?: string;
};

export type ResponseRegisterDomainUser = {timestampMS: number};

export type ResponseEditDomainUser = {timestampMS: number};

export type ActionGetCompleteUser = {
	// TODO "type": "getCompleteUser"
	domain: string;
	address: Address;
};
export type ResponseGetCompleteUser = {completeUser: (DomainUser & MissivUser) | undefined};

export type Action =
	| ActionRegisterDomainUser
	| ActionSendMessage
	| ActionGetConversations
	| ActionGetUnacceptedConversations
	| ActionGetAcceptedConversations
	| ActionMarkAsRead
	| ActionGetMessages
	| ActionAcceptConversation
	| ActionGetMissivUser
	| ActionGetDomainUser
	| {
			type: 'db:select';
			table: string;
	  }
	| {
			type: 'db:reset';
	  };

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export function originPublicKeyPublicationMessage(orig: string, publicKey: `0x${string}`): string {
	return `Origin: ${orig}\n\nIMPORTANT: Only sign on trusted websites.\n\nThis authorizes the following Public Key to represent your account:\n\n${publicKey}\n\nOthers can use this key to write encrypted messages to you securely.`;
}

export type ClientMessageType =
	| {address: `0x${string}`; signature: `0x${string}`}
	| {message: string; signature: `0x${string}`}
	| {logout: true};

export type ServerMessageType =
	| {challenge: string; id: string}
	| {joined: `0x${string}`; id: string; publicKey: `0x${string}`}
	| {message: string; from: string; timestamp: number; signature: `0x${string}`}
	| {quit: string; id: string}
	| {error: string; cause?: any; stack?: string};

export function fromDomainToOrigin(domain: string) {
	if (domain.startsWith('https://')) {
		return domain;
	}
	if (domain === 'localhost' || domain.startsWith('localhost:')) {
		return `http://${domain}`;
	}
	return `https://${domain}`;
}
