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
    -- TODO : senderPublicKey
    message TEXT NOT NULL, -- should be encrypted // {}
    timestamp TIMESTAMP NOT NULL,
    PRIMARY KEY (domain, namespace, conversationID, messageID, recipient)
);

-- Helps with queries that filter on conversation and recipient, and order by timestamp.
-- Useful for the getMessages query and the markAsRead operation.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_recipient_timestamp ON Messages(domain, namespace, conversationID, recipient, timestamp);


CREATE TABLE IF NOT EXISTS Conversations (
    -----------------------------------------------------------------------------------------------
    -- PRIMARY KEY
    -----------------------------------------------------------------------------------------------
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    -----------------------------------------------------------------------------------------------
    -- TODO? firstMessage (clear or encrypted for all ) // denormalization for preview
    creationDate TIMESTAMP NOT NULL,
    members TEXT NOT NULL,
    name TEXT,
    lastMessage TIMESTAMP NOT NULL,
    PRIMARY KEY (domain, namespace, conversationID)
);

-- Index to help with querying recent conversations 
CREATE INDEX IF NOT EXISTS idx_conversations_lastmessage ON Conversations(domain, namespace, conversationID, lastMessage);



-- Combined table for tracking participants and their read status
CREATE TABLE IF NOT EXISTS ConversationParticipants (
    -----------------------------------------------------------------------------------------------
    -- PRIMARY KEY
    -----------------------------------------------------------------------------------------------
    domain TEXT NOT NULL,
    namespace TEXT NOT NULL,
    conversationID TEXT NOT NULL,
    user TEXT NOT NULL,
    -----------------------------------------------------------------------------------------------
    status integer NOT NULL, -- 0 : unaccepted , 1: accepted , 2: rejected
    lastRead TIMESTAMP, -- when the user last read the conversation (NULL if never read) // TODO  0?
    PRIMARY KEY (domain, namespace, conversationID, user)
);


-- Index to help with querying user's conversations efficiently
CREATE INDEX IF NOT EXISTS idx_conversation_participants_participant ON ConversationParticipants(domain, namespace, conversationID, user);