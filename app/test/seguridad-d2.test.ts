// Seguridad, Deploy 2 review (Nov 25 2026): the fixes, plus checks that weekly mode leaves monthly people alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import deploy from "../scripts/deploy.sh?raw";
import { alertItems } from "../src/lib/alerts.ts";
import { call, makeUser } from "./helpers.ts";

const db = () => env.DB;

describe("deploy.sh and migrations (Deploy 2 adds 0007_budget.sql)", () => {
  it("stops before publishing while the live database lacks a migration", () => {
    const list = deploy.indexOf('$WR d1 migrations list finanzas --remote -c "$PROD"');
    const publish = deploy.indexOf('$WR deploy -c "$PROD"');
    expect(list).toBeGreaterThan(0);
    expect(list).toBeLessThan(publish);
    const guard = deploy.slice(list, publish);
    expect(guard).toMatch(/grep -Eo '\[0-9\]\{4\}_\[a-z0-9_\]\+\\\.sql'/);
    expect(guard).toMatch(/if \[ -n "\$PENDING" \]; then[\s\S]*?exit 1\nfi/);
    expect(guard).toContain("deploy-wave2.sh");
  });
});

describe("Personas keeps its big number (the glass box is Home only)", () => {
  it("app.css still sizes .summary .hero as before, and the boxed rule only touches .summary.boxed", async () => {
    // a CSS ?raw import comes back empty in this runner, so the file is read as the app serves it
    const css = await (await env.ASSETS.fetch("https://finanzas.test/app.css")).text();
    expect(css.length).toBeGreaterThan(1000);
    expect(css).toMatch(/\n\.summary \.hero \{ margin: 0 0 16px; font-size: 48px; line-height: 1\.08; \}/);
    // the boxed hero comes after it and wins by specificity on Home only
    expect(css.indexOf(".summary .hero {")).toBeLessThan(css.indexOf(".summary.boxed .hero {"));
  });
});

describe("weekly summary alert day", () => {
  const turnOn = (id: number) =>
    db().prepare("INSERT INTO alert_prefs (user_id, lim80, lim100, card_due, weekly, cash, updated_at) VALUES (?, 0, 0, 0, 1, 0, 1)").bind(id).run();
  // 2026-11-29 is a Sunday, 2026-11-28 a Saturday (19:00 El Salvador = 01:00 UTC the next day)
  const at = (fecha: string) => Date.parse(fecha + "T19:00:00-06:00");
  const keys = async (id: number, fecha: string) => (await alertItems(db(), id, "es", at(fecha))).items.map((i) => i.key);

  it("no budget row: Sunday, as before", async () => {
    const u = await makeUser("d2a");
    await turnOn(u.id);
    expect(await keys(u.id, "2026-11-29")).toEqual(["week:2026-11-29"]);
    expect(await keys(u.id, "2026-11-28")).toEqual([]);
  });
  it("her week starts Sunday: Saturday; monthly row with Monday start: Sunday", async () => {
    const u = await makeUser("d2b");
    await turnOn(u.id);
    expect((await call("PUT", "/api/me/budget", { period: "week", week_cents: null, week_start: 0 }, u.cookie)).status).toBe(200);
    expect(await keys(u.id, "2026-11-28")).toEqual(["week:2026-11-28"]);
    expect(await keys(u.id, "2026-11-29")).toEqual([]);
    expect((await call("PUT", "/api/me/budget", { period: "month", week_cents: null, week_start: 1 }, u.cookie)).status).toBe(200);
    expect(await keys(u.id, "2026-11-29")).toEqual(["week:2026-11-29"]);
  });
});

describe("a person with no budget row", () => {
  it("gets the same /summary and /home/extras bytes when someone else turns weekly on", async () => {
    const mel = await makeUser("d2m");
    const other = await makeUser("d2o");
    const text = async (path: string) => (await call("GET", path, undefined, mel.cookie)).text();
    const before = [await text("/api/summary"), await text("/api/home/extras")];
    expect(before[1]).not.toContain('"week"');
    expect((await call("PUT", "/api/me/budget", { period: "week", week_cents: 5000, week_start: 3 }, other.cookie)).status).toBe(200);
    expect([await text("/api/summary"), await text("/api/home/extras")]).toEqual(before);
    const row = await db().prepare("SELECT COUNT(*) AS n FROM budget_prefs WHERE user_id = ?").bind(mel.id).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
