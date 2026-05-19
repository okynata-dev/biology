-- Migration 0002 — verifiable rejection-roll audit trail.
--
-- Adds a `roll_hex` column to the log table. Each conjugation records
-- the deterministic SHA-256 digest of (signature || nonce || donorId ||
-- recipientId) as a hex string. The first 8 hex chars (uint32) divided
-- by 2^32 yields the rejection roll — making the outcome fully
-- reproducible by anyone with the signature payload. No more "trust
-- the server's Math.random()".
--
-- Backfill is impossible for old rows; they retain NULL roll_hex,
-- which means "legacy log entry, roll not verifiable". New rows fill it.
--
-- Run once against the live D1 instance:
--   wrangler d1 execute bioms-lab --file=migrations/0002_log_roll_hex.sql --remote
--
-- Safe to run multiple times (errors on second run because SQLite has
-- no IF NOT EXISTS on ALTER TABLE ADD COLUMN, but D1 batches still go
-- through after the no-op error — check output before assuming OK).

ALTER TABLE log ADD COLUMN roll_hex TEXT;
