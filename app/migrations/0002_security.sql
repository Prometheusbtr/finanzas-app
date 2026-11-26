-- Security fixes (Seguridad, Wave 1). No data rows are changed or moved.

-- M1: login counters. One row per IP ("ip:<hash>", 10 tries a minute) and one per username plus IP
-- ("name:<hash>", 5 tries in 15 minutes). Only hashes are stored, never the IP or the typed name.
-- The old table held only short-lived counters, so nothing is lost by dropping it.
DROP TABLE login_throttle;
CREATE TABLE login_limits (
  k TEXT PRIMARY KEY,
  tries INTEGER NOT NULL,
  window_start INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX login_limits_window ON login_limits(window_start);

-- M2: one owner (Melvin) can end other users' sessions. The first user ever created is the owner;
-- on a new database add-user.ts --owner sets it.
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));
UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- M2: a new passphrase (or any change to how a user signs in) ends all of that user's sessions,
-- whatever path made the change (app, script or hand-written SQL).
CREATE TRIGGER users_login_changed AFTER UPDATE OF pass_salt, pass_hash ON users
WHEN NEW.pass_salt IS NOT OLD.pass_salt OR NEW.pass_hash IS NOT OLD.pass_hash
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
END;

-- Low: the database itself refuses a link from one user's row to another user's row.
-- (Real composite foreign keys would need the tables rebuilt, and in D1 dropping the old table
-- would run its ON DELETE CASCADE rules and delete rows. These checks keep every row as it is.)
CREATE TRIGGER categories_same_user_ins BEFORE INSERT ON categories
WHEN NOT EXISTS (SELECT 1 FROM groups WHERE id = NEW.group_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER categories_same_user_upd BEFORE UPDATE OF group_id ON categories
WHEN NOT EXISTS (SELECT 1 FROM groups WHERE id = NEW.group_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

CREATE TRIGGER movements_same_user_ins BEFORE INSERT ON movements
WHEN (NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id))
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER movements_same_user_upd BEFORE UPDATE OF account_id, category_id ON movements
WHEN (NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id))
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

CREATE TRIGGER merchant_rules_same_user_ins BEFORE INSERT ON merchant_rules
WHEN NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER merchant_rules_same_user_upd BEFORE UPDATE OF category_id ON merchant_rules
WHEN NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

CREATE TRIGGER merge_suggestions_same_user_ins BEFORE INSERT ON merge_suggestions
WHEN NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.bank_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.manual_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER merge_suggestions_same_user_upd BEFORE UPDATE OF bank_id, manual_id ON merge_suggestions
WHEN NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.bank_id AND user_id = NEW.user_id)
  OR NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.manual_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

-- A row never moves to another user.
CREATE TRIGGER groups_user_fixed BEFORE UPDATE OF user_id ON groups WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER categories_user_fixed BEFORE UPDATE OF user_id ON categories WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER accounts_user_fixed BEFORE UPDATE OF user_id ON accounts WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER movements_user_fixed BEFORE UPDATE OF user_id ON movements WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER merchant_rules_user_fixed BEFORE UPDATE OF user_id ON merchant_rules WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER merge_suggestions_user_fixed BEFORE UPDATE OF user_id ON merge_suggestions WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER sessions_user_fixed BEFORE UPDATE OF user_id ON sessions WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
