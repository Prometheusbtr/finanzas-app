-- Cuentas (Wave 2): invites, sign-up, passkeys (Face ID), the own-password fallback, devices and sessions,
-- the Face ID lock and the "Primeros pasos" checklist. No data rows are changed or moved.

-- ---------- login methods on users ----------
-- passkey_handle: the WebAuthn user.id (random, base64url), never the row id.
-- pw_salt / pw_hash: her own password. The phone runs PBKDF2 with pw_salt; the server keeps a salted SHA-256
-- of that result (like the passphrase). backup_used_at: last sign-in with the backup code (the passphrase)
-- while another login method exists. app_lock: Face ID each time the app opens (checklist step 8).
ALTER TABLE users ADD COLUMN passkey_handle TEXT;
ALTER TABLE users ADD COLUMN pw_salt TEXT;
ALTER TABLE users ADD COLUMN pw_hash TEXT;
ALTER TABLE users ADD COLUMN backup_used_at INTEGER;
ALTER TABLE users ADD COLUMN app_lock INTEGER NOT NULL DEFAULT 0 CHECK (app_lock IN (0, 1));
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
CREATE UNIQUE INDEX users_passkey_handle ON users(passkey_handle);

-- A new password or a backup code sign-in ends all of that user's sessions, like users_login_changed
-- (migration 0002) does for the passphrase. The route then starts one new session for the device in use.
CREATE TRIGGER users_login_changed_2 AFTER UPDATE OF pw_salt, pw_hash, backup_used_at ON users
WHEN NEW.pw_salt IS NOT OLD.pw_salt OR NEW.pw_hash IS NOT OLD.pw_hash OR NEW.backup_used_at IS NOT OLD.backup_used_at
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
END;

-- ---------- sessions: device label, last use, Face ID lock proof ----------
-- unlock_hash: SHA-256 of the proof the page holds in memory after a Face ID check (never the proof itself).
ALTER TABLE sessions ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_used_at INTEGER;
ALTER TABLE sessions ADD COLUMN unlock_hash TEXT;
ALTER TABLE sessions ADD COLUMN unlocked_at INTEGER;

-- ---------- passkeys ----------
CREATE TABLE passkeys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred_id TEXT NOT NULL UNIQUE,             -- base64url credential id
  public_key TEXT NOT NULL,                 -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',    -- JSON array
  label TEXT NOT NULL DEFAULT '',           -- "iPhone · Safari", from the device that made it
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- Adding, removing or changing a passkey is a login-method change: every session of that user ends.
CREATE TRIGGER passkeys_added AFTER INSERT ON passkeys
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER passkeys_removed AFTER DELETE ON passkeys
BEGIN
  DELETE FROM sessions WHERE user_id = OLD.user_id;
END;
CREATE TRIGGER passkeys_changed AFTER UPDATE OF cred_id, public_key ON passkeys
WHEN NEW.cred_id IS NOT OLD.cred_id OR NEW.public_key IS NOT OLD.public_key
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.user_id;
END;
-- The Face ID lock needs a passkey: when the last one goes, the lock goes off, so nobody is locked out.
CREATE TRIGGER passkeys_last_removed AFTER DELETE ON passkeys
WHEN NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = OLD.user_id)
BEGIN
  UPDATE users SET app_lock = 0 WHERE id = OLD.user_id;
END;
CREATE TRIGGER passkeys_user_fixed BEFORE UPDATE OF user_id ON passkeys WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;

-- ---------- invites (sign-up) and Face ID reset links ----------
-- Only the token's SHA-256 is stored. A sign-up invite lasts 7 days, a reset link 3 days; each is used once.
CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the owner who made it
  kind TEXT NOT NULL CHECK (kind IN ('signup', 'reset')),
  target_id INTEGER REFERENCES users(id) ON DELETE CASCADE,          -- reset: whose Face ID
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  cancelled_at INTEGER,
  CHECK ((kind = 'reset') = (target_id IS NOT NULL))
);
CREATE INDEX invites_owner ON invites(owner_id);

-- Only an owner makes invites, whatever path inserts the row.
CREATE TRIGGER invites_owner_only BEFORE INSERT ON invites
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id AND is_owner = 1)
BEGIN
  SELECT RAISE(ABORT, 'owner_only');
END;
-- One use, never after it was cancelled or ran out. The sign-up batch starts with this update, so a second
-- use (or a cancel that came first) rolls back the whole sign-up.
CREATE TRIGGER invites_once BEFORE UPDATE OF used_at ON invites
WHEN OLD.used_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.used_at >= OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'invite_closed');
END;
CREATE TRIGGER invites_cancel_once BEFORE UPDATE OF cancelled_at ON invites
WHEN OLD.used_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invite_closed');
END;
CREATE TRIGGER invites_fixed BEFORE UPDATE OF owner_id, kind, target_id, token_hash, expires_at ON invites
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.kind IS NOT OLD.kind OR NEW.target_id IS NOT OLD.target_id
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;

-- ---------- WebAuthn challenges: stored on the server, used once, 5 minutes ----------
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,               -- base64url, as sent to the browser
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'reset', 'register', 'login', 'unlock')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,       -- register, unlock: the signed-in user
  invite_id INTEGER REFERENCES invites(id) ON DELETE CASCADE,   -- signup, reset
  session_hash TEXT,                        -- register, unlock: the session that asked
  data TEXT NOT NULL DEFAULT '{}',          -- signup: the chosen username, name, user handle and password salt
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges(expires_at);
CREATE TRIGGER webauthn_challenges_user_fixed BEFORE UPDATE OF user_id ON webauthn_challenges
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;

-- ---------- "Primeros pasos" (per person) ----------
-- step 'card' holds the card itself (open or hidden); the others are the checklist steps.
-- waiting: Importar's "Esperar un mes" for limits; `at` says since when.
CREATE TABLE setup_steps (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK (step IN ('card', 'home_screen', 'accounts', 'life', 'statements', 'savings', 'limits', 'alerts', 'lock', 'bac_email')),
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'hidden', 'waiting')),
  at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',          -- life: the yes/no answers
  PRIMARY KEY (user_id, step),
  CHECK (step <> 'card' OR state IN ('open', 'hidden'))
) WITHOUT ROWID;
CREATE TRIGGER setup_steps_user_fixed BEFORE UPDATE OF user_id ON setup_steps WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;

-- Everyone who exists before this migration (Melvin) keeps today's Home: the card starts hidden.
-- He can open it from Ajustes.
INSERT INTO setup_steps (user_id, step, state, at)
SELECT id, 'card', 'hidden', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;

-- ---------- server keys ----------
-- fake_salt keys the stable made-up password salt for usernames that do not exist (or have no password),
-- so the salt answer says nothing about who has an account. Made here, in the database, never in git.
CREATE TABLE app_keys (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO app_keys (name, value) VALUES ('fake_salt', lower(hex(randomblob(32))));
