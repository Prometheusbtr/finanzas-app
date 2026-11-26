-- Statement upload (Importar, Wave 2). The file itself is never stored: only the rows the phone read
-- from it, the import they came in, and the user's choices during "Primeros pasos".

-- One upload of one statement (or CSV) into one account.
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('bac_tc', 'agricola_tc', 'uglycash', 'csv')),
  period_start TEXT NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  period_end TEXT NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  balanced INTEGER NOT NULL DEFAULT 0 CHECK (balanced IN (0, 1)),   -- the phone's check: the rows add up
  added INTEGER NOT NULL DEFAULT 0,      -- new rows saved
  already INTEGER NOT NULL DEFAULT 0,    -- rows that were already in the app (email, seed, earlier import)
  merged INTEGER NOT NULL DEFAULT 0,     -- rows typed by hand that this import joined to its bank row
  review INTEGER NOT NULL DEFAULT 0,     -- new rows waiting in Revisar
  parts INTEGER NOT NULL DEFAULT 0,      -- chunks saved so far: a resent chunk is refused, never saved twice
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'undone')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX imports_user ON imports(user_id, created_at);

-- What happened to each row of an import, so undo can put everything back.
-- kind: added (new movement), merged (a typed row was joined into the new movement; prev keeps the typed
-- row so undo restores it), already (the movement was already there: nothing written, only claimed).
CREATE TABLE import_rows (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movement_id INTEGER REFERENCES movements(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'merged', 'already')),
  base TEXT NOT NULL,                    -- account|fecha|tipo|cents: for the occurrence count
  prev TEXT,                             -- JSON of the typed row a merge removed
  created_at INTEGER NOT NULL
);
CREATE INDEX import_rows_import ON import_rows(import_id, base);
CREATE INDEX import_rows_user_day ON import_rows(user_id, created_at);
CREATE INDEX import_rows_movement ON import_rows(movement_id);

-- Which CSV column is which, remembered per bank file layout (its header line, hashed).
CREATE TABLE import_csv_maps (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  header_sig TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  map TEXT NOT NULL,                     -- JSON: column numbers, date order, sign rule
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, header_sig)
) WITHOUT ROWID;

-- Fixed payments found in the imported months, and whether the user keeps them.
CREATE TABLE recurring_choices (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  keep INTEGER NOT NULL CHECK (keep IN (0, 1)),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  every_days INTEGER NOT NULL CHECK (every_days > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, merchant_key)
) WITHOUT ROWID;

-- The monthly savings goal ("Primeros pasos", step 5). Kept apart from group limits on purpose:
-- Home's "Te quedan" is the sum of group limits minus spending, so a savings limit would raise it.
CREATE TABLE savings_plan (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  updated_at INTEGER NOT NULL
);

-- The database itself refuses a link from one user's row to another user's row (same as 0002).
CREATE TRIGGER imports_same_user_ins BEFORE INSERT ON imports
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER imports_same_user_upd BEFORE UPDATE OF account_id ON imports
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER import_rows_same_user_ins BEFORE INSERT ON import_rows
WHEN NOT EXISTS (SELECT 1 FROM imports WHERE id = NEW.import_id AND user_id = NEW.user_id)
  OR (NEW.movement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.movement_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER import_rows_same_user_upd BEFORE UPDATE OF import_id, movement_id ON import_rows
WHEN NOT EXISTS (SELECT 1 FROM imports WHERE id = NEW.import_id AND user_id = NEW.user_id)
  OR (NEW.movement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.movement_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER import_csv_maps_same_user_ins BEFORE INSERT ON import_csv_maps
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER import_csv_maps_same_user_upd BEFORE UPDATE OF account_id ON import_csv_maps
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

-- A row never moves to another user.
CREATE TRIGGER imports_user_fixed BEFORE UPDATE OF user_id ON imports WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER import_rows_user_fixed BEFORE UPDATE OF user_id ON import_rows WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER import_csv_maps_user_fixed BEFORE UPDATE OF user_id ON import_csv_maps WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER recurring_choices_user_fixed BEFORE UPDATE OF user_id ON recurring_choices WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER savings_plan_user_fixed BEFORE UPDATE OF user_id ON savings_plan WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
