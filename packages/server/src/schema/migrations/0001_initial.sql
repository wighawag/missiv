-- missiv 1.0's schema. A database made by missiv 0.x (Users, DomainUsers with
-- domainUsername, Messages with a JSON blob) is not migrated: 1.0 starts from an
-- empty database.

-- A wallet's delegate key in one domain: the ownership proof (the wallet's
-- signature over the publication message of `publicKey` for `appOrigin`, the
-- domain's origin) and the profile it shows in that domain. A key belongs to one
-- (user, domain).
CREATE TABLE DomainUsers (
  user TEXT NOT NULL,
  domain TEXT NOT NULL,
  publicKey TEXT NOT NULL,
  signature TEXT NOT NULL,
  appOrigin TEXT NOT NULL,
  name TEXT,
  description TEXT,
  added INTEGER NOT NULL,
  lastPresence INTEGER NOT NULL,
  PRIMARY KEY (user, domain),
  UNIQUE (publicKey)
);

-- A conversation is its member set: its ID is derived from the members.
CREATE TABLE Conversations (
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  creationDate INTEGER NOT NULL,
  members TEXT NOT NULL,
  lastMessage INTEGER NOT NULL,
  PRIMARY KEY (domain, namespace, conversationID)
);

-- Each member's view of a conversation. status: 0 unaccepted, 1 rejected, 2 accepted.
CREATE TABLE ConversationParticipants (
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  user TEXT NOT NULL,
  status INTEGER NOT NULL,
  lastRead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, namespace, conversationID, user)
);
-- the conversation lists: a user's conversations in a domain and namespace, by status
CREATE INDEX idx_participants_user ON ConversationParticipants (domain, namespace, user, status);

-- One row per recipient of a message (the sender's own copy included). messageID
-- is time-ordered (a ULID), shared by a message's rows; signature is the sender's
-- over this copy, stored as sent and checked by the reader, never here.
CREATE TABLE Messages (
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  recipient TEXT NOT NULL,
  messageID TEXT NOT NULL,
  sender TEXT NOT NULL,
  senderPublicKey TEXT NOT NULL,
  -- the sender's ownership proof of senderPublicKey when it sent, so a reader can
  -- check the message after the sender has replaced the key
  senderOwnershipSignature TEXT NOT NULL,
  senderAppOrigin TEXT NOT NULL,
  recipientPublicKey TEXT,
  messageType TEXT NOT NULL,
  content TEXT NOT NULL,
  signature TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (domain, namespace, conversationID, recipient, messageID)
);

-- `user` blocked `blocked` in a domain: nothing from `blocked` reaches `user` there.
CREATE TABLE Blocks (
  domain TEXT NOT NULL,
  user TEXT NOT NULL,
  blocked TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (domain, user, blocked)
);

-- Request signatures accepted on a route that must not run twice, kept until
-- their time window has passed, so a replay within it is refused.
CREATE TABLE RequestSignatures (
  signature TEXT NOT NULL PRIMARY KEY,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX idx_request_signatures_expiry ON RequestSignatures (expiresAt);
