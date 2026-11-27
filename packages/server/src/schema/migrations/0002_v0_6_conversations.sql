-- missiv 0.6's direct messaging (ADR-0005, ADR-0006): one row per message,
-- ordered by a per-conversation seq, and one inbox row per member. It replaces
-- 0001_v0_6's per-recipient copies, which no release ever stored (0.6 starts
-- from an empty database), so their tables are dropped rather than migrated:
-- a database made by an unreleased 0.6 build loses its test messages, a fresh
-- one runs both files.
DROP INDEX IF EXISTS idx_participants_user;
DROP TABLE IF EXISTS Messages;
DROP TABLE IF EXISTS ConversationParticipants;
DROP TABLE IF EXISTS Conversations;

-- The ConversationStore: a conversation's messages, keyed by
-- (domain, namespace, conversationID, seq); seq is assigned by the store (the
-- conversation's previous one plus one, from 1), messageID is the client's
-- ULID, unique within the conversation. signature is the sender's Ed25519
-- signature over the message (verified before it is stored, and by every
-- reader). hiddenFrom is the member who blocked the sender in the domain when
-- it was sent: the sender sees it, that member never does.
CREATE TABLE Messages (
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  seq INTEGER NOT NULL,
  messageID TEXT NOT NULL,
  sender TEXT NOT NULL,
  senderKeyRef TEXT NOT NULL,
  scheme TEXT NOT NULL,
  keyID TEXT,
  content TEXT NOT NULL,
  signature TEXT NOT NULL,
  serverTimestamp INTEGER NOT NULL,
  hiddenFrom TEXT,
  PRIMARY KEY (domain, namespace, conversationID, seq),
  UNIQUE (domain, namespace, conversationID, messageID)
);

-- The Inbox: each member's view of a conversation. status: 0 unaccepted,
-- 1 rejected, 2 accepted. lastSeq is the newest message the member can see,
-- lastReadSeq the newest it marked read (unread while lastReadSeq < lastSeq),
-- lastMessageAt that message's serverTimestamp, which orders the lists.
CREATE TABLE Inbox (
  user TEXT NOT NULL,
  domain TEXT NOT NULL,
  namespace TEXT NOT NULL,
  conversationID TEXT NOT NULL,
  status INTEGER NOT NULL,
  lastSeq INTEGER NOT NULL,
  lastReadSeq INTEGER NOT NULL,
  lastMessageAt INTEGER NOT NULL,
  PRIMARY KEY (user, domain, namespace, conversationID)
);
-- the lists by status, newest first, and the list of every status
CREATE INDEX idx_inbox_by_status ON Inbox (user, domain, namespace, status, lastMessageAt DESC, conversationID DESC);
CREATE INDEX idx_inbox_all ON Inbox (user, domain, namespace, lastMessageAt DESC, conversationID DESC);
