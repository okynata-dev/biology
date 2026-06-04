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
  absorbed_seeds        TEXT,    -- JSON array of seeds burned into this token (rank ladder)
  updated_at            INTEGER  -- unix seconds
);

-- Permanent record of on-chain burns. Primary key on burned_token_id
-- enforces "a token can only be burned once" at the schema level —
-- replay attempts (same token sent through twice) will UNIQUE-violate.
-- tx_hash is verifiable on any block explorer.
CREATE TABLE IF NOT EXISTS burns (
  burned_token_id      INTEGER PRIMARY KEY,
  recipient_token_id   INTEGER NOT NULL,
  signer               TEXT NOT NULL,
  tx_hash              TEXT NOT NULL,
  burned_at            INTEGER NOT NULL    -- unix milliseconds
);
CREATE INDEX IF NOT EXISTS idx_burns_recipient ON burns(recipient_token_id);
CREATE INDEX IF NOT EXISTS idx_burns_signer    ON burns(signer);
CREATE INDEX IF NOT EXISTS idx_burns_burned_at ON burns(burned_at);

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
-- Idempotency / dedup guard: blocks duplicate retries from inserting two
-- depletion rows for the same (donor, trait) at the same instant. The
-- LIVE anti-double-spend check (donor can't donate the same trait to
-- two recipients while a cooldown is active) is enforced in worker.js
-- handleConjugate() via an INSERT ... WHERE NOT EXISTS guard wrapped
-- inside env.DB.batch() with the nonce + log + token_state writes, so
-- the whole conjugation is atomic. This index is the schema-level
-- belt-and-suspenders backup.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_depletions_grant
  ON depletions(token_id, trait, donated_at);

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
  result      TEXT NOT NULL,       -- 'transfer' | 'rejected' | 'os_refresh_failed' | 'conjugate_race'
  signer      TEXT NOT NULL,
  roll_hex    TEXT                 -- SHA-256(sig || nonce || donor || recipient) — verifiable rejection roll
);
CREATE INDEX IF NOT EXISTS idx_log_ts        ON log(ts);
CREATE INDEX IF NOT EXISTS idx_log_donor     ON log(donor);
CREATE INDEX IF NOT EXISTS idx_log_recipient ON log(recipient);

-- Pre-mint waitlist — one row per address/email submitted via /reserve.
-- `value` is lowercased so dedup catches case variants. `kind` is
-- either 'address' (Ethereum hex) or 'email'.
CREATE TABLE IF NOT EXISTS waitlist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,        -- 'address' | 'email'
  value       TEXT NOT NULL UNIQUE, -- lowercased
  ts          INTEGER NOT NULL,     -- unix milliseconds
  ip_hash     TEXT                  -- sha256(ip + salt), for soft rate-limit only
);
CREATE INDEX IF NOT EXISTS idx_waitlist_ts ON waitlist(ts);
CREATE INDEX IF NOT EXISTS idx_waitlist_kind ON waitlist(kind);

-- Community whitelist-allocation applications. SEPARATE from `waitlist`
-- (individual signups). Community leaders apply here for a batch of spots;
-- the owner reviews each, validates the submitted member wallets on-chain,
-- and only then merges approved addresses into `waitlist` by hand. Nothing
-- here auto-enters the snapshot. `status` is 'pending' | 'approved' | 'rejected'.
-- `member_addrs` is the raw pasted ENS/0x list (newline-separated), stored
-- verbatim — resolution/validation happens offline, not on submit.
CREATE TABLE IF NOT EXISTS partners (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  community        TEXT NOT NULL,
  about            TEXT,
  twitter          TEXT,
  audience_size    TEXT,
  discord          TEXT,
  links            TEXT,
  requested_spots  INTEGER,
  member_addrs     TEXT,
  contact          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  ts               INTEGER NOT NULL,    -- unix milliseconds
  ip_hash          TEXT                 -- sha256(ip + ':partner:' + salt); soft rate-limit only
);
CREATE INDEX IF NOT EXISTS idx_partners_ts     ON partners(ts);
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
CREATE INDEX IF NOT EXISTS idx_partners_iphash ON partners(ip_hash);

-- Per-IP burn throttle (fail-open). Append-only; one row per burn attempt,
-- counted over a 60s window in worker.js _ipRateOk(). The per-signer limit
-- only sees successful burns, so this is what stops valid-signature spam
-- from draining the Alchemy quota. Safe to prune rows older than an hour
-- post-launch (low volume during the drop window).
CREATE TABLE IF NOT EXISTS rl_hits (
  ip_hash  TEXT NOT NULL,
  ts       INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_rl_hits ON rl_hits(ip_hash, ts);
