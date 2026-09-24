CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE entries (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, value REAL, unit TEXT NOT NULL,
  notes TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id), external_id TEXT
);
CREATE INDEX entries_start ON entries(started_at);
CREATE INDEX entries_end ON entries(ended_at);
CREATE TABLE sync_receipts (
  device_id TEXT NOT NULL REFERENCES devices(id), event_id TEXT NOT NULL,
  digest TEXT NOT NULL, PRIMARY KEY(device_id, event_id)
);
-- A conflicting retry aborts the ENTIRE D1 batch, including new entries.
CREATE TRIGGER receipt_conflict BEFORE UPDATE OF digest ON sync_receipts
WHEN OLD.digest != NEW.digest
BEGIN SELECT RAISE(ABORT, 'event_id_conflict'); END;
-- Recheck revocation inside the ingestion transaction, including empty heartbeats.
CREATE TRIGGER revoked_upload BEFORE UPDATE OF last_seen ON devices
WHEN OLD.revoked != 0
BEGIN SELECT RAISE(ABORT, 'device_revoked'); END;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limit (
  id INTEGER PRIMARY KEY CHECK(id = 1), window INTEGER NOT NULL, attempts INTEGER NOT NULL
);
