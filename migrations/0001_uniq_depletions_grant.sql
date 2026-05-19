-- Migration 0001 — idempotency guard on depletions.
--
-- Adds a unique index on (token_id, trait, donated_at). Prevents a
-- retried INSERT (same conjugation event arriving twice) from creating
-- two depletion rows. Live double-spend prevention (donor can't donate
-- the same trait twice while cooldown is active) is enforced in
-- worker.js handleConjugate() via INSERT ... WHERE NOT EXISTS inside
-- a D1 batch, so the full conjugation is atomic. This index is the
-- schema-level belt-and-suspenders backup.
--
-- Run once against the live D1 instance:
--   wrangler d1 execute bioms-lab --file=migrations/0001_uniq_depletions_grant.sql --remote
--
-- Safe to run multiple times (IF NOT EXISTS).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_depletions_grant
  ON depletions(token_id, trait, donated_at);
