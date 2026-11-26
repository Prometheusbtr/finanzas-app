// Creating a user: one list of SQL statements shared by the Worker (sign-up through an invite) and
// scripts/add-user.ts (which writes them to a .sql file for wrangler). Later statements find the new user
// by username, so the whole list can run as one batch (one transaction) before the user id is known.
import { DEFAULT_GROUPS, PERSONAL_GROUPS } from "./defaults.ts";

export type SqlValue = string | number | null;
export type Stmt = { sql: string; params: SqlValue[] };

/** Usernames chosen at sign-up: 3 to 32 of a-z, 0-9, dot, dash, underscore. */
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export type NewUser = {
  username: string; // already normalized (lowercase)
  displayName: string;
  lang: "es" | "en";
  passSalt: string; // the backup code (app-made passphrase): salt and hash, never the passphrase
  passHash: string;
  /** "first": owner only when no user exists yet (add-user.ts). "never": a person who signs up. */
  owner: "first" | "never";
  /** The starter groups and categories (DEFAULT_GROUPS minus PERSONAL_GROUPS), with no limits. */
  defaults: boolean;
  /** The "Primeros pasos" card on Home starts open (sign-up) or hidden (people made with the script). */
  setupCard: "open" | "hidden";
  passkeyHandle?: string | null;
  pwSalt?: string | null;
  pwHash?: string | null;
  now: number;
};

const ID = "(SELECT id FROM users WHERE username = ?)";

export function newUserStatements(u: NewUser): Stmt[] {
  const out: Stmt[] = [];
  const isOwner = u.owner === "first" ? "(SELECT COUNT(*) = 0 FROM users)" : "0";
  out.push({
    sql: `INSERT INTO users (username, display_name, pass_salt, pass_hash, lang, created_at, is_owner, passkey_handle, pw_salt, pw_hash)
      VALUES (?, ?, ?, ?, ?, ?, ${isOwner}, ?, ?, ?)`,
    params: [u.username, u.displayName, u.passSalt, u.passHash, u.lang, u.now, u.passkeyHandle ?? null, u.pwSalt ?? null, u.pwHash ?? null],
  });
  // VALUES with the id lookup: if the user row was not made, user_id is NULL and the batch stops here.
  out.push({ sql: `INSERT INTO setup_steps (user_id, step, state, at) VALUES (${ID}, 'card', ?, ?)`, params: [u.username, u.setupCard, u.now] });
  out.push({
    sql: `INSERT OR IGNORE INTO accounts (user_id, name, kind, sort) SELECT id, 'Efectivo', 'efectivo', 99 FROM users WHERE username = ?`,
    params: [u.username],
  });
  if (u.defaults) {
    DEFAULT_GROUPS.filter((g) => !PERSONAL_GROUPS.has(g.name)).forEach((g, gi) => {
      out.push({
        sql: `INSERT OR IGNORE INTO groups (user_id, name, sort) SELECT id, ?, ? FROM users WHERE username = ?`,
        params: [g.name, gi + 1, u.username],
      });
      g.cats.forEach(([name, kind], ci) => {
        out.push({
          sql: `INSERT OR IGNORE INTO categories (user_id, group_id, name, kind, sort) SELECT u.id, g.id, ?, ?, ?
            FROM users u JOIN groups g ON g.user_id = u.id AND g.name = ? WHERE u.username = ?`,
          params: [name, kind, ci + 1, g.name, u.username],
        });
      });
    });
  }
  return out;
}

/** The same statements for D1. */
export function toD1(db: D1Database, stmts: Stmt[]): D1PreparedStatement[] {
  return stmts.map((s) => db.prepare(s.sql).bind(...s.params));
}

/** The same statements as SQL text with the values written in (for a .sql file run by wrangler). */
export function toSqlText(stmts: Stmt[]): string {
  const lit = (v: SqlValue) => (v === null ? "NULL" : typeof v === "number" ? String(Math.trunc(v)) : `'${v.replace(/'/g, "''")}'`);
  return stmts
    .map((s) => {
      const parts = s.sql.replace(/\s*\n\s*/g, " ").split("?");
      if (parts.length - 1 !== s.params.length) throw new Error("placeholder count");
      return parts.reduce((acc, p, i) => acc + lit(s.params[i - 1]) + p) + ";";
    })
    .join("\n");
}

/** add-user --reset (F49): the new passphrase for an existing user, as SQL text. When no user has that name the
 * UPDATE changes nothing, so the next statement then breaks a NOT NULL rule on purpose and wrangler stops with an
 * error instead of saying it worked. */
export function resetLoginSql(username: string, salt: string, hash: string): string {
  return toSqlText([
    { sql: "UPDATE users SET pass_salt = ?, pass_hash = ? WHERE username = ?", params: [salt, hash, username] },
    { sql: "INSERT INTO users (username) SELECT NULL WHERE changes() = 0", params: [] },
  ]);
}
