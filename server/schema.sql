DROP TABLE IF EXISTS ComversationViews;
CREATE TABLE IF NOT EXISTS ComversationViews (
    first         text        NOT NULL,
    second        text        NOT NULL,
    conversation  text        NOT NULL,
    lastMessage   timestamp   NOT NULL, 
    accepted      boolean     NOT NULL,
    unread        boolean     NOT NULL,
    PRIMARY KEY (first, second),
    FOREIGN KEY (first) REFERENCES Users (address),
    FOREIGN KEY (second) REFERENCES Users (address)
);
CREATE INDEX IF NOT EXISTS idx_unread ON ComversationViews (first, accepted, unread);
CREATE INDEX IF NOT EXISTS idx_accepted ON ComversationViews (first, accepted);


DROP TABLE IF EXISTS Messages;
CREATE TABLE IF NOT EXISTS  Messages
(
  conversation text      NOT NULL,
  sender         text      NOT NULL,
  timestamp    timestamp NOT NULL,
  message      text      NOT NULL,
  signature    text      NOT NULL,
  PRIMARY KEY (conversation, sender, timestamp),
  FOREIGN KEY (sender) REFERENCES Users (address)
);
CREATE INDEX IF NOT EXISTS idx_messsages ON Messages (conversation);

DROP TABLE IF EXISTS Users;
CREATE TABLE IF NOT EXISTS Users
(
  address text      NOT NULL,
  keys    text      NOT NULL,
  created timestamp NULL    ,
  PRIMARY KEY (address)
);
CREATE INDEX IF NOT EXISTS idx_messsages ON Users (address);