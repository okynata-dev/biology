-- Migration 0003 — hard burn support.
--
-- Adds:
--   1. `burns` table — one row per token permanently removed from
--      supply via on-chain burn (Transfer to 0x0 or 0x...dEaD).
--      Primary key on burned_token_id enforces "a token can only be
--      burned once" at the schema level — defense against replay.
--      tx_hash is stored for verifiability: anyone can independently
--      look it up on a block explorer.
--
--   2. `absorbed_seeds` column on token_state — JSON array of seeds
--      that have been absorbed into this token via burn. Used to
--      compute rank (length of array + 1) and render lineage
--      ("Carries the memory of CYTOTARCHUS").
--
-- This migration is forward-only — burns are permanent, there's no
-- undo path.
--
-- Run once against the live D1 instance:
--   wrangler d1 execute bioms-lab --file=migrations/0003_burns_and_absorbed.sql --remote

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

-- Existing token_state rows need a default — empty JSON array means
-- "this token has not absorbed anyone yet".
ALTER TABLE token_state ADD COLUMN absorbed_seeds TEXT;
