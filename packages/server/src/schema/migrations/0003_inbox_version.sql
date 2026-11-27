-- The inbox version (ADR-0006 "Amendment: the inbox version and polling"):
-- each Inbox row records the version at which it last changed, and a user's
-- version in a domain is their highest row's, read backwards on
-- idx_inbox_version. A change of a row gives it that highest version plus one,
-- in the same statement. A row stored before this migration is numbered by its
-- rowid: unique in the table, so unique among the user's rows, and above 0, so
-- a poll from 0 lists it.
ALTER TABLE Inbox ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
UPDATE Inbox SET version = rowid;
CREATE INDEX idx_inbox_version ON Inbox (user, domain, version);
