// Create a user, or give an existing user a new passphrase, and write the SQL to run with wrangler.
//
//   node scripts/add-user.ts <username> "<Display name>" <out.sql> [--lang en] [--no-defaults]
//   node scripts/add-user.ts --reset <username> <out.sql>        (new passphrase; ends all their sessions)
//   Then: npx wrangler d1 execute finanzas --remote --file <out.sql>
//
// The passphrase is shown ONCE, straight on the terminal screen (/dev/tty), never on stdout or stderr,
// so it cannot end up in a log, a pipe or an AI session's transcript. Without a real terminal it refuses.
// Melvin runs it for the live app in his own terminal window, not through Claude.
//
// Local dev only: --local-login <file> writes the passphrase to that file (mode 600) instead, and only
// when <out.sql> has "local" in its name. Never use it for the live app.
// The SQL file holds only a salted hash, never the passphrase. The first user ever created is the owner.

import { chmodSync, closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { generatePassphrase, hashPassphrase, newSalt, normalizeUsername } from "../src/lib/auth.ts";
import { newUserStatements, resetLoginSql, toSqlText, USERNAME_RE } from "../src/lib/users.ts";

// People made here get the "Primeros pasos" card hidden (it is for people who sign up through an invite);
// --setup-card shows it.
const USAGE = `usage: node scripts/add-user.ts <username> "<Display name>" <out.sql> [--lang en] [--no-defaults] [--setup-card]
       node scripts/add-user.ts --reset <username> <out.sql>
       local dev only: add --local-login <file>`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const valueFlags = new Set(["--lang", "--local-login"]);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (valueFlags.has(a)) {
    if (i + 1 >= args.length) fail(USAGE);
    flags.set(a, args[++i]);
  } else if (a.startsWith("--")) flags.set(a, true);
  else pos.push(a);
}
const known = new Set(["--lang", "--local-login", "--no-defaults", "--reset", "--setup-card"]);
for (const f of flags.keys()) if (!known.has(f)) fail(`unknown option ${f}\n${USAGE}`);

const reset = flags.has("--reset");
const [rawName, display, outPath] = reset ? [pos[0], "", pos[1]] : [pos[0], pos[1], pos[2]];
const lang = (flags.get("--lang") as string | undefined) ?? "es";
const localLogin = flags.get("--local-login") as string | undefined;
if (!rawName || !outPath || (!reset && !display) || pos.length !== (reset ? 2 : 3) || !["es", "en"].includes(lang)) fail(USAGE);

const username = normalizeUsername(rawName);
// The same rule as sign-up through an invite (src/lib/users.ts): 3 to 32 of a-z, 0-9, dot, dash, underscore.
if (!USERNAME_RE.test(username)) fail("username: 3 to 32 letters, numbers, dot, dash or underscore");

// Where the passphrase goes. Decided before anything is generated, so a refusal leaves nothing behind.
let tty: number | null = null;
if (localLogin) {
  if (!basename(outPath).includes("local")) fail("--local-login is for the local dev database only: <out.sql> must have \"local\" in its name");
} else {
  if (!process.stdin.isTTY) fail("add-user needs a real terminal window. Run it yourself in your own terminal, not through Claude, a pipe or a script.");
  try {
    tty = openSync("/dev/tty", "w");
  } catch {
    fail("add-user needs a real terminal window (/dev/tty). Run it yourself in your own terminal.");
  }
}

const passphrase = generatePassphrase();
const salt = newSalt();
const hash = await hashPassphrase(passphrase, salt);
const now = Date.now();
const sql: string[] = [];
if (reset) {
  // The users_login_changed trigger (migration 0002) ends every session of this user.
  // F49: a name that does not exist makes wrangler stop with "NOT NULL constraint failed: users.username"
  sql.push(resetLoginSql(username, salt, hash));
} else {
  // The same statements the Worker runs when someone signs up through an invite (src/lib/users.ts).
  sql.push(toSqlText(newUserStatements({
    username, displayName: display, lang: lang as "es" | "en", passSalt: salt, passHash: hash, owner: "first",
    defaults: !flags.has("--no-defaults"), setupCard: flags.has("--setup-card") ? "open" : "hidden", now,
  })));
}
writeFileSync(outPath, sql.join("\n") + "\n", { mode: 0o600 });
chmodSync(outPath, 0o600);

if (localLogin) {
  writeFileSync(localLogin, `user: ${username}\npassphrase: ${passphrase}\n`, { mode: 0o600 });
  chmodSync(localLogin, 0o600);
  console.log(`user: ${username}\nsql: ${outPath}\nlocal passphrase saved in ${localLogin} (local dev only)`);
} else {
  writeSync(tty!, `\n  user:       ${username}\n  passphrase: ${passphrase}\n\n  Save it in your Passwords app now. It is not shown again or saved anywhere.\n\n`);
  closeSync(tty!);
  console.log(`user: ${username}\nsql: ${outPath}\n(passphrase shown on the terminal screen only)`);
}
if (reset) console.log(`If wrangler stops with "NOT NULL constraint failed: users.username", no user is named ${username}: nothing changed and that passphrase does nothing.`);
