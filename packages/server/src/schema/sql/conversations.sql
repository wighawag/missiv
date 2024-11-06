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

CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (namespace, first, lastMessage);

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

CREATE TABLE IF NOT EXISTS DomainUsers (
  user text NOT NULL,
  domain text NOT NULL,
  domainUsername text NULL,
  publicKey text NOT NULL,
  signature text NOT NULL,
  added timestamp NOT NULL,
  lastPresence timestamp NOT NULL,
  PRIMARY KEY (user, domain),
  UNIQUE(publicKey),
  FOREIGN KEY (user) REFERENCES Users (address)
);

CREATE INDEX IF NOT EXISTS idx_DomainUsers_publicKey ON DomainUsers (publicKey);

CREATE INDEX IF NOT EXISTS idx_DomainUsers_lastPresence ON DomainUsers (lastPresence);

CREATE TABLE IF NOT EXISTS Users (
  address text NOT NULL,
  name text NULL,
  created timestamp NOT NULL,
  PRIMARY KEY (address)
);