-- Bioms Lab — D1 schema.
-- Run with: wrangler d1 execute bioms-lab --file=schema.sql --remote
--
-- Three tables:
--   token_state   — per-token received mutations (palette / organelles / anomalies)
--   depletions    — per-token active cooldowns from donated traits
--   used_nonces   — EIP-712 signature replay protection
--   log           — append-only history of all conjugation attempts
--
-- D1 is SQLite under the hood. No foreign keys (D1 doesn't enforce them
-- by default); ON CONFLICT for upserts.

CREATE TABLE IF NOT EXISTS token_state (
  token_id              INTEGER PRIMARY KEY,
  received_palette      TEXT,
  received_organelles   TEXT,    -- JSON array, e.g. '["plasmid","flagellum"]'
  received_anomalies    TEXT,    -- JSON array
  updated_at            INTEGER  -- unix seconds
);

CREATE TABLE IF NOT EXISTS depletions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id        INTEGER NOT NULL,
  trait           TEXT NOT NULL,
  to_token        INTEGER NOT NULL,
  donated_at      INTEGER NOT NULL,    -- unix seconds
  regenerates_at  INTEGER NOT NULL     -- unix seconds; query: WHERE regenerates_at > now
);
CREATE INDEX IF NOT EXISTS idx_depletions_token       ON depletions(token_id);
CREATE INDEX IF NOT EXISTS idx_depletions_regenerates ON depletions(regenerates_at);

CREATE TABLE IF NOT EXISTS used_nonces (
  signer    TEXT NOT NULL,
  nonce     INTEGER NOT NULL,
  used_at   INTEGER NOT NULL,
  PRIMARY KEY (signer, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonces_used_at ON used_nonces(used_at);

CREATE TABLE IF NOT EXISTS log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,    -- unix milliseconds
  donor       INTEGER NOT NULL,
  recipient   INTEGER NOT NULL,
  trait       TEXT NOT NULL,
  result      TEXT NOT NULL,       -- 'transfer' | 'rejected'
  signer      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_ts        ON log(ts);
CREATE INDEX IF NOT EXISTS idx_log_donor     ON log(donor);
CREATE INDEX IF NOT EXISTS idx_log_recipient ON log(recipient);
