-- Read receipts (ADR-0006 "Amendment: read receipts"): each Inbox row carries
-- the other member's read point, otherReadSeq, raised by their markRead when
-- they share read receipts; a row stored before this migration has none (0).
ALTER TABLE Inbox ADD COLUMN otherReadSeq INTEGER NOT NULL DEFAULT 0;

-- An account's settings in a domain; no row means the defaults (read receipts
-- shared). readReceipts: 1 shared, 0 not.
CREATE TABLE InboxSettings (
  user TEXT NOT NULL,
  domain TEXT NOT NULL,
  readReceipts INTEGER NOT NULL,
  PRIMARY KEY (user, domain)
);
