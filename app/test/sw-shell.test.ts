// F42 (audit Nov 25 2026): the service worker stores the whole shell in one step and serves it from that version's
// cache. So its list must hold every module the app loads (a missing one would come from the network, perhaps a
// newer version) and every file on it must exist (one missing file makes the whole install fail).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import sw from "../public/sw.js?raw";
import index from "../public/index.html?raw";
import headers from "../public/_headers?raw";
import deploy from "../scripts/deploy.sh?raw";
import deployWave2 from "../scripts/deploy-wave2.sh?raw";
import { checkShell, cspOf, shellOf } from "../scripts/shell-check.mjs";

const files = Object.keys(import.meta.glob("../public/js/**/*.js")).map((p) => p.replace("../public", ""));
const { modules, shell } = shellOf(sw);

describe("F42: the service worker's shell list", () => {
  it("holds every module in public/js (and nothing that is not there)", () => {
    expect(files.filter((f) => !modules.includes(f))).toEqual([]);
    expect(modules.filter((f) => !files.includes(f))).toEqual([]);
  });

  it("holds every script the page loads", () => {
    for (const src of [...index.matchAll(/<script[^>]* src="([^"]+)"/g)].map((x) => x[1]!)) expect(shell).toContain(src);
  });

  it("names only files that the app serves", async () => {
    for (const path of shell) {
      const r = await env.ASSETS.fetch(new Request("https://finanzas.test" + path));
      expect([path, r.status]).toEqual([path, 200]);
    }
  });

  it("serves the shell from this version's cache and never stores /api", () => {
    expect(sw).toMatch(/const CACHE = "fz-shell-v\d+"/);
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    expect(sw).toContain("caches.open(CACHE).then((c) =>\n      c.match(url.pathname)");
  });
});

// Seguridad (Wave 4 review): cache-first means a phone only takes new shell files when sw.js changes. A deploy that
// edits a shell file but keeps CACHE would leave installed phones on the old files for good, so deploy.sh runs
// scripts/shell-check.mjs against the live app first and stops in that case.
describe("F42 guard: a changed shell needs a new CACHE (scripts/shell-check.mjs)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const live = new Map(shell.map((p) => [p, enc("file " + p)]));
  const base = {
    swText: sw, headersText: headers, liveSwText: sw, liveCsp: cspOf(headers),
    readLocal: async (p: string) => live.get(p)!, fetchLive: async (p: string) => live.get(p)!,
  };

  it("reads CACHE, the shell and the page policy", () => {
    expect(shellOf(sw).cache).toMatch(/^fz-shell-v\d+$/);
    expect(shell).toContain("/");
    expect(shell).toContain("/boot-check.js");
    expect(cspOf(headers)).toContain("script-src 'self'");
  });

  it("the same CACHE with the same files passes", async () => {
    expect((await checkShell(base)).status).toBe("same");
  });

  it("the same CACHE with one changed file, or a changed policy, is refused", async () => {
    const r = await checkShell({ ...base, readLocal: async (p) => (p === "/js/router.js" ? enc("new router") : live.get(p)!) });
    expect(r).toEqual({ status: "changed", liveCache: shellOf(sw).cache, changed: ["/js/router.js"] });
    const c = await checkShell({ ...base, liveCsp: "default-src *" });
    expect(c.status).toBe("changed");
    expect(c.changed).toEqual(["Content-Security-Policy (public/_headers)"]);
  });

  it("a new CACHE passes without comparing files", async () => {
    const older = sw.replace(/const CACHE = "fz-shell-v\d+"/, 'const CACHE = "fz-shell-v1"');
    const r = await checkShell({ ...base, liveSwText: older, fetchLive: async () => { throw new Error("not read"); } });
    expect(r.status).toBe("new");
    expect(r.liveCache).toBe("fz-shell-v1");
  });

  it("deploy.sh and deploy-wave2.sh run the check before they change anything and stop on a changed shell", () => {
    for (const script of [deploy, deployWave2]) {
      const at = script.indexOf('node scripts/shell-check.mjs "$ORIGIN"');
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(script.indexOf("read -rs -p \"Cloudflare API token")); // before the token, so before any change
      expect(script).toMatch(/if \[ "\$SHELL_RC" = 1 \]; then\n[^\n]*\n  exit 1/);
    }
  });
});
