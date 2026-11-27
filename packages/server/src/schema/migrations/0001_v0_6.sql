-- missiv 0.6's schema. A database made by missiv 0.5 or earlier is not migrated:
-- 0.6 starts from an empty database (ADR-0004). The file is named apart from
-- 0.5's `0001_initial`, so a 0.5 database fails to migrate (its tables exist)
-- instead of running on the wrong schema.

-- Every key set registered in a domain, current or replaced, by its reference
-- (delegated-identity's `keySetRef`): the account, its two public keys and the
-- ownership proof (the wallet's signature over the publication message of the
-- key set for `appOrigin`, the domain's origin). A key set, and each of its
-- keys, belongs to one (user, domain).
CREATE TABLE KeySets (
  domain TEXT NOT NULL,
  keyRef TEXT NOT NULL,
  user TEXT NOT NULL,
  signingKey TEXT NOT NULL,
  encryptionKey TEXT NOT NULL,
  ownershipSignature TEXT NOT NULL,
  appOrigin TEXT NOT NULL,
  registered INTEGER NOT NULL,
  PRIMARY KEY (domain, keyRef),
  UNIQUE (signingKey),
  UNIQUE (encryptionKey)
);

-- A wallet in one domain: its current key set (`keyRef`, in KeySets) and the
-- profile it shows in that domain.
CREATE TABLE DomainUsers (
  user TEXT NOT NULL,
  domain TEXT NOT NULL,
  keyRef TEXT NOT NULL,
  name TEXT,
  description TEXT,
  added INTEGER NOT NULL,
  lastPresence INTEGER NOT NULL,
  PRIMARY KEY (user, domain)
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

-- One row per recipient of a message (the sender's own copy included), 0.5's
-- format on 0.6's keys until the one-ciphertext format. messageID is
-- time-ordered (a ULID), shared by a message's rows; signature is the sender's
-- Ed25519 signature over this copy, stored as sent and checked by the reader,
-- never here.
CREATE TABLE Messages (
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  recipient TEXT NOT NULL,
  messageID TEXT NOT NULL,
  sender TEXT NOT NULL,
  -- the sender's key set when it sent (in KeySets, kept after a replacement), so
  -- a reader can check the message after the sender has replaced it
  senderKeyRef TEXT NOT NULL,
  -- the X25519 key an encrypted copy is encrypted to; null for a clear one
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
