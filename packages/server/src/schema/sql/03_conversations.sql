-- Messages Table
CREATE TABLE IF NOT EXISTS Messages (
    -----------------------------------------------------------------------------------------------
    -- PRIMARY KEY
    -----------------------------------------------------------------------------------------------
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    messageID INTEGER NOT NULL, -- shared id
    recipient TEXT NOT NULL, -- recipient of the message (includes sender too)
    -----------------------------------------------------------------------------------------------
    
    sender TEXT NOT NULL, -- sender of the message
    message TEXT NOT NULL, -- should be encrypted
    timestamp TIMESTAMP NOT NULL,
    PRIMARY KEY (domain, namespace, conversationID, messageID, recipient)
);

-- Helps with queries that filter on conversation and recipient, and order by timestamp.
-- Useful for the getMessages query and the markAsRead operation.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_recipient_timestamp ON Messages(domain, namespace, conversationID, recipient, timestamp);

-- Helps with queries that filter on recipient and order by timestamp.
-- Useful for getting the latest messages for a user across all conversations.
-- we should not need this
-- CREATE INDEX IF NOT EXISTS idx_messages_recipient_timestamp ON Messages(recipient, timestamp);


-- LastMessageTimestamp Table
CREATE TABLE IF NOT EXISTS LastMessageTimestamp (
    -----------------------------------------------------------------------------------------------
    -- PRIMARY KEY
    -----------------------------------------------------------------------------------------------
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    recipient TEXT NOT NULL,
    -----------------------------------------------------------------------------------------------

    timestamp TIMESTAMP NOT NULL,
    PRIMARY KEY (domain, namespace, conversationID, recipient)
);

-- Helps with joining LastMessageTimestamp to ConversationViews in the conversation listing queries.
CREATE INDEX IF NOT EXISTS idx_lastmessagetimestamp ON LastMessageTimestamp(domain, namespace, conversationID, recipient, timestamp);

-- Helps with queries that need to find the latest message timestamp for a recipient.
CREATE INDEX IF NOT EXISTS idx_lastmessagetimestamp_recipient_timestamp ON LastMessageTimestamp(domain, namespace, recipient, timestamp);

-- ConversationViews Table
CREATE TABLE IF NOT EXISTS ConversationViews (
    -----------------------------------------------------------------------------------------------
    -- PRIMARY KEY
    -----------------------------------------------------------------------------------------------
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    user TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    -----------------------------------------------------------------------------------------------
    members TEXT NOT NULL,
    accepted BOOLEAN NOT NULL,
    lastRead INTEGER NOT NULL,
    PRIMARY KEY (domain, namespace, user, conversationID)
);

-- Helps with filtering conversations by user and accepted status.
-- Useful for the getAcceptedConversations and getUnacceptedConversations queries.
CREATE INDEX IF NOT EXISTS idx_conversationviews_user_accepted ON ConversationViews(user, accepted);

-- Helps with looking up specific conversation views for a user.
-- Useful for the markAsRead operation.
CREATE INDEX IF NOT EXISTS idx_conversationviews_conversation_user ON ConversationViews(domain, namespace, conversationID, user);


-- does not seem to work on bun at least
-- so instead of perform the operaiton in the update (sendMessage)
-- Trigger to update LastMessageTimestamp
-- CREATE TRIGGER IF NOT EXISTS update_last_message_timestamp 
-- AFTER INSERT ON Messages 
-- BEGIN
--     INSERT OR REPLACE INTO LastMessageTimestamp (domain, namespace, conversationID, recipient, timestamp)
--     VALUES (NEW.domain, NEW.namespace, NEW.conversationID, NEW.recipient, NEW.timestamp);
-- END;

-- Optional: Conversations Table (if you need to store conversation metadata)
CREATE TABLE IF NOT EXISTS Conversations (
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    creationDate TIMESTAMP NOT NULL,
    name TEXT,
    PRIMARY KEY (domain, namespace, conversationID)
);


