-- 0004_image_version.sql
-- Per-token image version counter for cache-busting after re-renders.
--
-- The R2 master PNG and its CDN-cache entries have immutable cache
-- (max-age=31536000, immutable) — once a master is uploaded, browsers
-- + Cloudflare Edge will hold the same bytes for a year.
--
-- When a burn/conjugate mutates a token's traits, we re-render the
-- master via the Browser Rendering pipeline and overwrite the R2 key.
-- But the immutable cache means readers won't see the new bytes
-- until we change the URL. The version counter is appended as
-- `?v=N` to the image URL in metadata, so every regen bumps the
-- effective URL → CDN treats it as a fresh asset → cache miss → R2
-- → new master returned.
--
-- Default 1 for all existing tokens so legacy metadata URLs stay valid.

ALTER TABLE token_state ADD COLUMN image_version INTEGER NOT NULL DEFAULT 1;
