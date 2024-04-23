import {sqliteTable, text, integer, primaryKey, index, unique, uniqueIndex} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	address: text('address', {length: 256}).primaryKey(),
	name: text('name', {length: 256}),
	created: integer('created', {mode: 'timestamp'}).notNull(),
});

// // we do not set these foreign key as we want to be able to send message to unregistered users
// // FOREIGN KEY (first) REFERENCES Users (address),
// // FOREIGN KEY (second) REFERENCES Users (address)
export const conversations = sqliteTable(
	'conversations',
	{
		domain: text('domain', {length: 256}).notNull(),
		namespace: text('namespace', {length: 256}).notNull(),
		first: text('first', {length: 256}).notNull(),
		second: text('second', {length: 256}).notNull(),
		conversationID: text('conversationID', {length: 256}).notNull(),
		lastMessage: integer('lastMessage', {mode: 'timestamp'}).notNull(),
		accepted: integer('accepted', {mode: 'boolean'}).notNull(),
		read: integer('read', {mode: 'boolean'}).notNull(),
	},
	(table) => {
		return {
			pk: primaryKey({columns: [table.domain, table.namespace, table.first, table.conversationID]}),
			idx_Conversations_all_conversations: index('idx_Conversations_all_conversations').on(
				table.namespace,
				table.first,
				table.lastMessage,
			),
			idx_Conversations_accepted: index('idx_Conversations_accepted').on(
				table.domain,
				table.namespace,
				table.first,
				table.accepted,
				table.lastMessage,
			),
			idx_Conversations_read: index('idx_Conversations_read').on(
				table.domain,
				table.namespace,
				table.first,
				table.read,
				table.lastMessage,
			),
		};
	},
);

// // we do not set these foreign key as we want to be able to send message to unregistered users
// // FOREIGN KEY (sender) REFERENCES Users (address)
// // FOREIGN KEY (recipient) REFERENCES Users (address),
export const messages = sqliteTable(
	'messages',
	{
		id: integer('id', {mode: 'number'}).primaryKey(),
		domain: text('domain', {length: 256}).notNull(),
		namespace: text('namespace', {length: 256}).notNull(),
		conversationID: text('conversationID', {length: 256}).notNull(),
		sender: text('sender', {length: 256}).notNull(),
		senderPublicKey: text('senderPublicKey', {length: 256}).notNull(),
		recipient: text('recipient', {length: 256}).notNull(),
		recipientPublicKey: text('recipientPublicKey', {length: 256}),
		timestamp: integer('timestamp', {mode: 'timestamp'}).notNull(),
		message: text('message').notNull(),
		type: text('type', {length: 256}).notNull(), // TODO enum
		signature: text('signature', {length: 256}).notNull(),
	},
	(table) => {
		return {
			idx_Messsages_list: index('idx_Messsages_list').on(
				table.domain,
				table.namespace,
				table.conversationID,
				table.timestamp,
			),
			idx_Messsages_id: index('idx_Messsages_id').on(table.id, table.timestamp),
		};
	},
);

export const domainusers = sqliteTable(
	'domainusers',
	{
		user: text('user').references(() => users.address),
		domain: text('domain', {length: 256}).notNull(),
		domainUsername: text('domainUsername', {length: 256}),
		publicKey: text('publicKey', {length: 256}).notNull(),
		signature: text('signature', {length: 256}).notNull(),
		added: integer('added', {mode: 'timestamp'}).notNull(),
		lastPresence: integer('lastPresence', {mode: 'timestamp'}).notNull(),
	},
	(table) => {
		return {
			pk: primaryKey({columns: [table.user, table.domain]}),
			idx_DomainUsers_publicKey: uniqueIndex('idx_DomainUsers_publicKey').on(table.publicKey),
			idx_DomainUsers_lastPresence: index('idx_DomainUsers_lastPresence').on(table.lastPresence),
		};
	},
);
