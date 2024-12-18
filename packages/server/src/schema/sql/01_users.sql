CREATE TABLE IF NOT EXISTS Users (
  address text NOT NULL,
  name text NULL,
  description text NULL,
  created timestamp NOT NULL,
  PRIMARY KEY (address)
);

CREATE TABLE IF NOT EXISTS DomainUsers (
  user text NOT NULL,
  domain text NOT NULL,
  domainUsername text NULL,
  domainDescription text NULL,
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

