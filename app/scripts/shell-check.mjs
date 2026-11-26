// F42 guard (Seguridad, Nov 25 2026): the service worker serves the app shell from its cache first and only takes
// new files when public/sw.js changes. A deploy that changes a shell file but keeps the same CACHE name would leave
// every installed iPhone on the old shell for good, next to a newer server. deploy.sh runs this first:
//
//     node scripts/shell-check.mjs https://the-live-origin
//
// It compares the live sw.js's CACHE with this checkout's. A new CACHE is fine (the phones install the new set).
// The same CACHE is fine only when every shell file, and the page's security policy, is byte for byte the live one.
// Exit 0: fine. Exit 1: a shell file changed under the same CACHE (change CACHE in public/sw.js). Exit 3: the live
// app could not be read. It reads public files only and sends nothing but plain GETs for them.

/** CACHE and the full SHELL list (MODULES expanded) from sw.js's text. */
export function shellOf(sw) {
  const cache = (sw.match(/const CACHE = "([^"]+)"/) || [])[1] || null;
  const list = (dir) => {
    const m = sw.match(new RegExp(`\\[([^\\]]*)\\]\\.map\\(\\(m\\) => \`/js/${dir}\\$\\{m\\}\\.js\`\\)`));
    if (!m) throw new Error("sw.js: no module list for /js/" + dir);
    return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => `/js/${dir}${x[1]}.js`);
  };
  const s = sw.match(/const SHELL = \[([^\]]*)\]/);
  if (!s) throw new Error("sw.js: no SHELL list");
  const modules = [...list(""), ...list("screens/")];
  return { cache, modules, shell: [...s[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).concat(modules) };
}

/** The Content-Security-Policy that public/_headers gives every page. */
export function cspOf(headers) {
  const m = headers.match(/^\s*Content-Security-Policy:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The check itself, with the file reads passed in (tested in test/sw-shell.test.ts).
 * readLocal(path) and fetchLive(path) give a Uint8Array; liveCsp is the live "/" response's policy header.
 */
export async function checkShell({ swText, headersText, liveSwText, liveCsp, readLocal, fetchLive }) {
  const local = shellOf(swText);
  let liveCache = null;
  try {
    liveCache = shellOf(liveSwText).cache;
  } catch {}
  if (!local.cache) return { status: "broken", liveCache, changed: [] };
  if (liveCache !== local.cache) return { status: "new", liveCache, changed: [] };
  const changed = [];
  for (const path of local.shell) {
    const [a, b] = await Promise.all([readLocal(path), fetchLive(path)]);
    if (!same([...a], [...b])) changed.push(path);
  }
  if ((cspOf(headersText) || "") !== (liveCsp || "")) changed.push("Content-Security-Policy (public/_headers)");
  return { status: changed.length ? "changed" : "same", liveCache, changed };
}

async function main(origin) {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const pub = fileURLToPath(new URL("../public/", import.meta.url));
  if (!/^https?:\/\/[a-z0-9.:-]+$/i.test(origin || "")) {
    console.error("usage: node scripts/shell-check.mjs https://the-live-origin");
    return 3;
  }
  const get = async (path) => {
    const res = await fetch(origin + path, { cache: "no-store", redirect: "error", headers: { "Accept-Encoding": "identity" } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res;
  };
  let liveSwText, liveCsp;
  try {
    liveSwText = await (await get("/sw.js")).text();
    liveCsp = (await get("/")).headers.get("content-security-policy");
  } catch (e) {
    console.error("Could not read the live app to compare the shell: " + e.message);
    return 3;
  }
  const r = await checkShell({
    swText: await readFile(pub + "sw.js", "utf8"),
    headersText: await readFile(pub + "_headers", "utf8"),
    liveSwText,
    liveCsp,
    readLocal: async (p) => new Uint8Array(await readFile(pub + (p === "/" ? "index.html" : p.slice(1)))),
    fetchLive: async (p) => new Uint8Array(await (await get(p)).arrayBuffer()),
  }).catch((e) => ({ status: "error", error: e }));
  if (r.status === "error") {
    console.error("Could not compare the shell: " + r.error.message);
    return 3;
  }
  if (r.status === "broken") {
    console.error("public/sw.js has no CACHE name.");
    return 1;
  }
  if (r.status === "new") {
    console.log(`Shell: new version ${shellOf(await readFile(pub + "sw.js", "utf8")).cache} (live has ${r.liveCache || "none"}).`);
    return 0;
  }
  if (r.status === "same") {
    console.log(`Shell: unchanged, ${r.liveCache} stays.`);
    return 0;
  }
  console.error(`These shell files differ from the live app, but public/sw.js still says ${r.liveCache}:`);
  for (const p of r.changed) console.error("  " + p);
  console.error("Installed phones would keep the old files. Change CACHE in public/sw.js (for example to the next number).");
  return 1;
}

const argv = globalThis.process && globalThis.process.argv;
if (argv && argv[1] && /shell-check\.mjs$/.test(argv[1]) && import.meta.url.endsWith("/scripts/shell-check.mjs")) {
  main(argv[2]).then((code) => globalThis.process.exit(code));
}
