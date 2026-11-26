# Finanzas app (Step 2)

Cloudflare Worker (Hono + Zod) with a D1 database. Plain HTML/CSS/JS front end in `public/`, no build step.

Needs Node 22 (`nvm use` reads `.nvmrc`). The machine default stays Node 20.

## Run locally

    cd ~/finanzas/app && nvm use && npm run dev      # http://127.0.0.1:8788

Local login: `~/finanzas/data/.local-dev-login.txt` (local only; the live app gets a new passphrase).
After pulling new migrations run `npm run db:migrate:local` once, then restart the dev server.
Security notes, checks and the attack script: `SECURITY.md`.

## Rebuild the local database from the Step 1 ledger

    rm -rf .wrangler/state/v3/d1
    npm run db:migrate:local
    node scripts/add-user.ts melvin "Melvin" ../data/user-melvin-local.sql --no-defaults --local-login ../data/.local-dev-login.txt
    npx wrangler d1 execute finanzas --local --file ../data/user-melvin-local.sql
    npm run seed:sql && npm run seed:local

`--local-login` is for this local database only (the SQL file name must contain "local").
For the live app add-user shows the passphrase on the terminal screen only and refuses to run without one.

`--no-defaults` because the seed creates Melvin's groups, categories, limits, accounts and shop rules.
Categories that name people come from `../data/personal_rules.json` (out of git), next to the ledger.
Before any commit run `scripts/git-privacy-check.sh` (names and card endings it looks for are in `../data/privacy_terms.txt`).
A new user gets the default categories (none that name people): `node scripts/add-user.ts <name> "<Name>" <out.sql>`.
New passphrase for an existing user (ends all their sessions): `node scripts/add-user.ts --reset <name> <out.sql>`.
The first user ever created is the owner (can end other users' sessions).

## Checks

    npm run typecheck && npm test

## First deploy (only after Melvin approves the local preview and Seguridad signs off)

Melvin does steps 1 to 5 himself, in his own terminal window, not through Claude.

1. Cloudflare dashboard (personal Chrome profile): My Profile, API Tokens, Create Token, Custom token.
   Permissions: Account, Workers Scripts, Edit; Account, D1, Edit. Nothing else.
   Account Resources: only his account. TTL: a few days is enough; make a new one for later deploys.
   Copy the account id from the dashboard home too. No `wrangler login`: that one can touch the whole account.
2. In the terminal, so the token is not saved in shell history or any file:

       read -rs -p "Cloudflare token: " CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
       export CLOUDFLARE_ACCOUNT_ID=<account id>

3. `npx wrangler d1 create finanzas`, then put the new id in `wrangler.jsonc`.
4. `npx wrangler d1 migrations apply finanzas --remote`
5. `node scripts/add-user.ts melvin "Melvin" ../data/user-melvin-live.sql --no-defaults` (shows the live passphrase
   once, on the screen only; save it in Passwords), then
   `npx wrangler d1 execute finanzas --remote --file ../data/user-melvin-live.sql`
   and `npx wrangler d1 execute finanzas --remote --file ../data/seed.sql`.
6. `npx wrangler deploy` (address: `finanzas.<account-subdomain>.workers.dev`). Then delete or let the token expire.

If wrangler says a permission is missing, add only that one (for example Account Settings, Read).

## Notifications and the Funciones release (Personas, Tarjetas, Recurrentes, Alertas, Moneda)

Melvin does this himself, in his own terminal window, not through Claude, once the lead has merged the branch:

    cd ~/finanzas/app && npm ci && bash scripts/deploy-wave2.sh

It asks for the "finanzas-deploy" token (hidden; Workers Scripts Edit + D1 Edit, valid until Dec 2 2026) and stops
at the first error with a message saying how far it got. In order:

1. Saves a D1 Time Travel bookmark of the live database and prints it with the restore command (keep that line).
2. Lists the migrations the live database does not have (it should be 0003, 0004 and 0005; it stops if an older one
   shows up) and applies them. Wrangler asks "continue? (Y/n)": answer Y. They add tables, columns and checks; no existing row changes.
3. Makes the Web Push key pair only when the live app has no `VAPID_PRIVATE_KEY` secret yet
   (`scripts/vapid-keys.ts --live`: the private key goes straight to `wrangler secret put`, never printed or saved;
   the public key goes into `wrangler.production.jsonc`). Commit that one-line change afterwards.
4. Publishes the code (this also registers the daily cron `0 1 * * *`, 7 pm El Salvador) and prints what to check:
   on the iPhone, close and reopen Finanzas, Ajustes, Alertas, "Activar alertas", allow, then "Enviar una prueba".

Running it again is safe (applied migrations and an existing key are skipped). Later releases use `deploy.sh`,
except one that adds a migration (Deploy 2 adds `0007_budget.sql`): `deploy.sh` then stops before publishing and
says to run `deploy-wave2.sh`, which applies it first.

Locally: `node scripts/vapid-keys.ts --dev` writes both keys to `.dev.vars` (git-ignored). Run the daily job by hand
with `npx wrangler dev --local --test-scheduled` and open `/__scheduled?cron=0+1+*+*+*`. Headless browsers cannot get
real pushes; the server accepts only https addresses on Apple, Google, Mozilla and Microsoft push hosts.

## Data rules

Money in whole cents. `fecha` is the El Salvador date (UTC-6). Only `gasto` counts as spending, `abono` subtracts.
Every row has `user_id`; every query filters on it. `dedupe_key` is unique per user (manual rows use the
browser's client_id, seed rows use `seed:...`). The seed already holds every BAC email up to Nov 24 2026,
so Step 3's capture must not re-send older emails.
