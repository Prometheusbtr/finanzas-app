-- Finanzas schema v1.
-- Money is whole cents. "fecha" is the El Salvador local date (UTC-6, no daylight saving).
-- Every data row carries user_id and every query filters on it.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,            -- always lowercase
  display_name TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en')),
  created_at INTEGER NOT NULL
);

-- Failed logins per typed username (also for names that do not exist).
CREATE TABLE login_throttle (
  username TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256 of the cookie token, never the token itself
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  limit_cents INTEGER CHECK (limit_cents IS NULL OR limit_cents >= 0),
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('E', 'G', 'A', 'M')),  -- Esencial, Gusto, Ahorro, Mixto
  limit_cents INTEGER CHECK (limit_cents IS NULL OR limit_cents >= 0),
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'tarjeta' CHECK (kind IN ('tarjeta', 'cuenta', 'efectivo', 'billetera')),
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, name)
);

CREATE TABLE movements (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  hora TEXT CHECK (hora IS NULL OR hora GLOB '[0-2][0-9]:[0-5][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- Only gasto counts as spending; abono (refund) subtracts from it.
  tipo TEXT NOT NULL CHECK (tipo IN ('gasto', 'abono', 'ingreso', 'interno', 'rechazado', 'ignorado')),
  comercio TEXT NOT NULL DEFAULT '',
  merchant_key TEXT NOT NULL DEFAULT '',
  account_id INTEGER REFERENCES accounts(id),
  category_id INTEGER REFERENCES categories(id),
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
  nota TEXT NOT NULL DEFAULT '',
  origen TEXT NOT NULL,                     -- manual, correo BAC, estado de cuenta, estado UglyCash, ...
  estado TEXT NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'revisar')),
  raw TEXT,                                 -- original source text, never dropped
  dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX movements_user_fecha ON movements(user_id, fecha);
CREATE INDEX movements_user_estado ON movements(user_id, estado);
CREATE INDEX movements_user_match ON movements(user_id, account_id, amount_cents, fecha);

-- "This shop is this category", learned from the user's own choices.
CREATE TABLE merchant_rules (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, merchant_key)
);

-- A bank movement that may be the same purchase as one typed by hand (more than one match).
CREATE TABLE merge_suggestions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  manual_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (bank_id, manual_id)
);
