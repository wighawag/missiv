

DROP TABLE IF EXISTS ComversationViews;
CREATE TABLE IF NOT EXISTS ComversationViews (
    first         text        NOT NULL,
    second        text        NOT NULL,
    conversation  text        NOT NULL,
    lastMessage   timestamp   NOT NULL, 
    accepted      boolean        NOT NULL,
    unread        boolean     NOT NULL,
    PRIMARY KEY (first, second)
);
CREATE INDEX idx_accepted ON ComversationViews (accepted);
CREATE INDEX idx_unread ON ComversationViews (unread);

--DROP TABLE IF EXISTS Comversation;
--CREATE TABLE IF NOT EXISTS Customers (CustomerId INTEGER PRIMARY KEY, CompanyName TEXT, ContactName TEXT);
--INSERT INTO Customers (CustomerID, CompanyName, ContactName) VALUES (1, 'Alfreds Futterkiste', 'Maria Anders'), (4, 'Around the Horn', 'Thomas Hardy'), (11, 'Bs Beverages', 'Victoria Ashworth'), (13, 'Bs Beverages', 'Random Name');
