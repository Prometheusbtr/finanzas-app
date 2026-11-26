-- Funciones (Wave 2): other currencies on movements, Personas (who owes whom), Tarjetas (closing day, due day,
-- limit, statements), Recurrentes (fixed payments) and the evening notification (Web Push), plus the 24-hour wait
-- on Face ID reset links (end of file).
-- No existing row is changed or moved: the new columns start empty, so every total stays the same.

-- ---------- Moneda ----------
-- amount_cents stays the USD value and is the only amount any total adds. The original amount is kept beside it,
-- in whole cents of its own currency (a fixed list), never added into a total. fx_micros: units of that currency
-- for 1 USD, times 1,000,000 (an integer, no floats). A Wise send: amount_cents = USD sent, orig_cents = what
-- arrived, fee_cents = Wise's fee in USD (part of what was sent).
ALTER TABLE movements ADD COLUMN orig_currency TEXT
  CHECK (orig_currency IS NULL OR orig_currency IN ('COP', 'EUR', 'MXN', 'GTQ', 'HNL', 'NIO', 'CRC', 'PEN', 'CAD', 'GBP', 'BRL', 'DOP'));
ALTER TABLE movements ADD COLUMN orig_cents INTEGER
  CHECK (orig_cents IS NULL OR (orig_currency IS NOT NULL AND orig_cents BETWEEN 1 AND 100000000000000));
ALTER TABLE movements ADD COLUMN fx_micros INTEGER
  CHECK (fx_micros IS NULL OR (orig_cents IS NOT NULL AND fx_micros BETWEEN 1 AND 100000000000000));
ALTER TABLE movements ADD COLUMN fee_cents INTEGER
  CHECK (fee_cents IS NULL OR (orig_cents IS NOT NULL AND fee_cents BETWEEN 0 AND amount_cents));

-- ---------- Personas ----------
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

-- One line of a person's balance. cents > 0: they owe me more; cents < 0: I owe them more.
-- paid_for and shared point at my purchase (their part); they_paid at the purchase they paid for me (my spending,
-- added with no account); settle at the repayment (tipo interno, never spending). A movement that goes away
-- leaves the line and its amount (SET NULL), so the balance never changes behind her back.
CREATE TABLE person_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  movement_id INTEGER REFERENCES movements(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paid_for', 'shared', 'they_paid', 'settle')),
  cents INTEGER NOT NULL CHECK (cents <> 0 AND abs(cents) <= 10000000),
  fecha TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  nota TEXT NOT NULL DEFAULT '' CHECK (length(nota) <= 200),
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 8 AND 64), -- a retry never saves twice
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX person_entries_client ON person_entries(user_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX person_entries_person ON person_entries(user_id, person_id);
CREATE INDEX person_entries_movement ON person_entries(movement_id);
-- One share per person and purchase.
CREATE UNIQUE INDEX person_entries_one_share ON person_entries(person_id, movement_id) WHERE kind IN ('paid_for', 'shared');

-- ---------- Tarjetas ----------
-- One row per card account: closing day, due day and credit limit. No card number, expiry or code, ever.
CREATE TABLE cards (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  closing_day INTEGER CHECK (closing_day IS NULL OR closing_day BETWEEN 1 AND 31),
  due_day INTEGER CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  limit_cents INTEGER CHECK (limit_cents IS NULL OR limit_cents BETWEEN 0 AND 10000000),
  updated_at INTEGER NOT NULL
);
CREATE INDEX cards_user ON cards(user_id);

-- A card statement's dates and payments (from the BAC statement email in Step 3 later, or typed). One per closing.
CREATE TABLE card_statements (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  closing_date TEXT NOT NULL CHECK (closing_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  min_cents INTEGER CHECK (min_cents IS NULL OR min_cents BETWEEN 0 AND 10000000),
  full_cents INTEGER CHECK (full_cents IS NULL OR full_cents BETWEEN 0 AND 10000000),
  source TEXT NOT NULL CHECK (source IN ('email', 'import', 'manual')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, account_id, closing_date)
);

-- ---------- Recurrentes ----------
-- A fixed payment: what, how much, how often and the next date. Nothing runs on its own: the app only shows what is
-- coming and counts it against the month until the real charge arrives (matched by shop or category and amount).
CREATE TABLE recurring (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  merchant_key TEXT NOT NULL DEFAULT '' CHECK (length(merchant_key) <= 80),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000),
  every TEXT NOT NULL CHECK (every IN ('week', '2weeks', 'month', 'year')),
  next_date TEXT NOT NULL CHECK (next_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  account_id INTEGER REFERENCES accounts(id),
  category_id INTEGER REFERENCES categories(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'suggested')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX recurring_user ON recurring(user_id, active);
CREATE UNIQUE INDEX recurring_merchant ON recurring(user_id, merchant_key) WHERE merchant_key <> '';

-- ---------- Notificaciones ----------
-- Which evening alerts she wants. No row = the defaults (all on except the cash reminder).
CREATE TABLE alert_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lim80 INTEGER NOT NULL DEFAULT 1 CHECK (lim80 IN (0, 1)),
  lim100 INTEGER NOT NULL DEFAULT 1 CHECK (lim100 IN (0, 1)),
  card_due INTEGER NOT NULL DEFAULT 1 CHECK (card_due IN (0, 1)),
  weekly INTEGER NOT NULL DEFAULT 1 CHECK (weekly IN (0, 1)),
  cash INTEGER NOT NULL DEFAULT 0 CHECK (cash IN (0, 1)),
  updated_at INTEGER NOT NULL
);

-- A Web Push subscription belongs to one session: when that session ends (sign out, sign out everywhere, a new
-- login method, the 180 days), the row goes with it. Only https endpoints on the real push services are stored
-- (checked in src/lib/webpush.ts before the insert).
CREATE TABLE push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 1024 AND substr(endpoint, 1, 8) = 'https://'),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 16 AND 32),
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE INDEX push_subs_user ON push_subs(user_id);
CREATE INDEX push_subs_session ON push_subs(session_hash);

-- One notification per person per El Salvador day (slot daily), plus at most 3 test sends a day. The primary key
-- is the cap: a second run of the evening job finds the day taken and sends nothing.
CREATE TABLE push_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  slot TEXT NOT NULL CHECK (slot IN ('daily', 'test1', 'test2', 'test3')),
  sent_at INTEGER NOT NULL,
  items INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, slot)
) WITHOUT ROWID;

-- Each alert item by its key (card:<account>:<due date>, lim100:<group>:<month>, lim80:..., week:<day>,
-- cash:<day>): the day it went in a notification (so it goes once) and when its banner was closed.
CREATE TABLE alert_marks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) <= 64),
  pushed_day TEXT,
  dismissed_at INTEGER,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

-- ---------- the database refuses links across users (same as 0002 and 0004) ----------
CREATE TRIGGER person_entries_same_user_ins BEFORE INSERT ON person_entries
WHEN NOT EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND user_id = NEW.user_id)
  OR (NEW.movement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.movement_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER person_entries_same_user_upd BEFORE UPDATE OF person_id, movement_id ON person_entries
WHEN NOT EXISTS (SELECT 1 FROM people WHERE id = NEW.person_id AND user_id = NEW.user_id)
  OR (NEW.movement_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM movements WHERE id = NEW.movement_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER cards_same_user_ins BEFORE INSERT ON cards
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER cards_same_user_upd BEFORE UPDATE OF account_id ON cards
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER card_statements_same_user_ins BEFORE INSERT ON card_statements
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER card_statements_same_user_upd BEFORE UPDATE OF account_id ON card_statements
WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER recurring_same_user_ins BEFORE INSERT ON recurring
WHEN (NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id))
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER recurring_same_user_upd BEFORE UPDATE OF account_id, category_id ON recurring
WHEN (NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id))
  OR (NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND user_id = NEW.user_id))
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER push_subs_same_user_ins BEFORE INSERT ON push_subs
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = NEW.session_hash AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;
CREATE TRIGGER push_subs_same_user_upd BEFORE UPDATE OF session_hash ON push_subs
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = NEW.session_hash AND user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'cross_user');
END;

-- ---------- a row never moves to another user ----------
CREATE TRIGGER people_user_fixed BEFORE UPDATE OF user_id ON people WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER person_entries_user_fixed BEFORE UPDATE OF user_id ON person_entries WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER cards_user_fixed BEFORE UPDATE OF user_id ON cards WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER card_statements_user_fixed BEFORE UPDATE OF user_id ON card_statements WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER recurring_user_fixed BEFORE UPDATE OF user_id ON recurring WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER alert_prefs_user_fixed BEFORE UPDATE OF user_id ON alert_prefs WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER push_subs_user_fixed BEFORE UPDATE OF user_id ON push_subs WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER push_log_user_fixed BEFORE UPDATE OF user_id ON push_log WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;
CREATE TRIGGER alert_marks_user_fixed BEFORE UPDATE OF user_id ON alert_marks WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_fixed');
END;

-- ---------- Face ID reset links (Melvin's decision, Nov 25 2026) ----------
-- A reset link works only from 24 hours after it is made (to its 3 days), so she sees it on Home and in Mi cuenta
-- first and can cancel it. The route checks this; the trigger holds it for any path that uses a link up.
-- 86400000 ms = RESET_WAIT_MS in src/routes/invites.ts. cancelled_by: who closed it (the owner, she herself, or
-- the owner's newer link for her), for her history in Mi cuenta. Existing rows keep NULL.
ALTER TABLE invites ADD COLUMN cancelled_by TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('owner', 'self', 'replaced'));
CREATE TRIGGER invites_reset_wait BEFORE UPDATE OF used_at ON invites
WHEN OLD.kind = 'reset' AND NEW.used_at IS NOT NULL AND NEW.used_at < OLD.created_at + 86400000
BEGIN
  SELECT RAISE(ABORT, 'invite_closed');
END;
