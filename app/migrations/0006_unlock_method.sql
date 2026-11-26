-- Audit Nov 25 2026, F06 and F47: how a session's lock proof was made. The sensitive changes that need a fresh
-- check (requireFresh) accept a proof only when its method is the one that person must use: Face ID when they
-- have a Face ID that still counts. A password sign-in with the lock on still opens the lock, but it is no longer
-- the Face ID check. Rows made before this migration have no method: they still open the lock and are not fresh
-- (that only matters for the 5 minutes after the deploy).
-- No existing row is changed: the new column starts empty, so every total stays the same.
ALTER TABLE sessions ADD COLUMN unlock_method TEXT
  CHECK (unlock_method IS NULL OR unlock_method IN ('passkey', 'password', 'passphrase'));
