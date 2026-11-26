-- Weekly "Te quedan" (Nov 2026). How each person counts what is left: per month (the default) or per week.
-- No row = per month, exactly as before this table existed. Group and category limits stay monthly either way.
CREATE TABLE budget_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('month', 'week')),
  -- what she pays herself each week; NULL = worked out from her monthly limits
  week_cents INTEGER CHECK (week_cents IS NULL OR (week_cents >= 0 AND week_cents <= 10000000)),
  -- the day her week starts: 0 = Sunday ... 6 = Saturday (Monday by default)
  week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  updated_at INTEGER NOT NULL
);
