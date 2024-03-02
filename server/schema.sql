DROP TABLE IF EXISTS Conversations;
CREATE TABLE IF NOT EXISTS Conversations (
    first         text        NOT NULL,
    second        text        NOT NULL,
    conversationID  text        NOT NULL,
    lastMessage   timestamp   NOT NULL, 
    accepted      boolean     NOT NULL,
    read        boolean     NOT NULL,
    PRIMARY KEY (first, second),
    FOREIGN KEY (first) REFERENCES Users (address),
    FOREIGN KEY (second) REFERENCES Users (address)
);
CREATE INDEX IF NOT EXISTS idx_read ON Conversations (first, accepted, read);
CREATE INDEX IF NOT EXISTS idx_accepted ON Conversations (first, accepted);


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