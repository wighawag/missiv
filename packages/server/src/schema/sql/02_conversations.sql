CREATE TABLE IF NOT EXISTS Conversations (
  domain text NOT NULL,
  namespace text NOT NULL,
  first text NOT NULL,
  second text NOT NULL,
  conversationID text NOT NULL,
  lastMessage timestamp NOT NULL,
  accepted boolean NOT NULL,
  read boolean NOT NULL,
  PRIMARY KEY (domain, namespace, first, conversationID)
);

CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (domain, namespace, first, lastMessage); 

CREATE INDEX IF NOT EXISTS idx_Conversations_accepted ON Conversations (domain, namespace, first, accepted, lastMessage);

CREATE INDEX IF NOT EXISTS idx_Conversations_read ON Conversations (domain, namespace, first, read, lastMessage);

CREATE TABLE IF NOT EXISTS Messages (
  id integer PRIMARY KEY,
  domain text NOT NULL,
  namespace text NOT NULL,
  conversationID text NOT NULL,
  sender text NOT NULL,
  senderPublicKey text NOT NULL,
  recipient text NOT NULL,
  recipientPublicKey text NULL,
  timestamp timestamp NOT NULL,
  message text NOT NULL,
  type text NOT NULL,
  signature text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_Messsages_list ON Messages (domain, namespace, conversationID, timestamp);

CREATE INDEX IF NOT EXISTS idx_Messsages_id ON Messages (id, timestamp);
