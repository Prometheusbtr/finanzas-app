import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { accountRoutes } from "./routes/account.ts";
import { ownerRoutes, publicRoutes, requireUnlocked, requireUser, sessionRoutes } from "./routes/auth.ts";
import { alertRoutes } from "./routes/alerts.ts";
import { cardRoutes } from "./routes/cards.ts";
import { importRoutes } from "./routes/import.ts";
import { invitePublicRoutes, memberRoutes } from "./routes/invites.ts";
import { movementRoutes } from "./routes/movements.ts";
import { peopleRoutes } from "./routes/people.ts";
import { recurringRoutes } from "./routes/recurring.ts";
import { stepRoutes } from "./routes/steps.ts";
import { reviewRoutes } from "./routes/review.ts";
import { setupRoutes } from "./routes/setup.ts";
import { summaryRoutes } from "./routes/summary.ts";
import { scheduled } from "./lib/alerts.ts";
import { MAX_BODY_BYTES, withSecurityHeaders } from "./lib/security.ts";
import type { AppEnv } from "./types.ts";

const READS = ["GET", "HEAD", "OPTIONS"];

/** Why a request must be refused before any route runs, or null. */
function requestProblem(c: Context): { error: string; status: 403 | 415 } | null {
  // The browser says where a request comes from. Writes must come from this same site;
  // reads may also be typed or opened from a bookmark ("none"), never sent by another site.
  const site = c.req.header("sec-fetch-site");
  if (!READS.includes(c.req.method)) {
    // Writes must be JSON from this same site. A form or another site cannot send that without CORS,
    // and this app sends no CORS headers, so this blocks cross-site request forgery.
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return { error: "json_only", status: 415 };
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return { error: "origin", status: 403 };
    if (site && site !== "same-origin") return { error: "cross_site", status: 403 };
  } else if (site === "cross-site" || site === "same-site") {
    return { error: "cross_site", status: 403 };
  }
  return null;
}

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", async (c, next) => {
  const problem = requestProblem(c);
  if (problem) return withSecurityHeaders(c.json({ error: problem.error }, problem.status));
  await next();
  withSecurityHeaders(c.res);
});

app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "too_big" }, 413) }));

app.route("/", publicRoutes);
app.route("/", invitePublicRoutes);

// Everything below needs a signed-in user, and with the Face ID lock on, a fresh Face ID proof
// (default deny: only sign out and the Face ID check itself work without it).
app.use("*", requireUser);
app.use("*", requireUnlocked);
app.route("/", sessionRoutes);
app.route("/", ownerRoutes);
app.route("/", memberRoutes);
app.route("/", accountRoutes);
app.route("/", stepRoutes);
app.route("/", summaryRoutes);
app.route("/", movementRoutes);
app.route("/", reviewRoutes);
app.route("/", setupRoutes);
app.route("/", importRoutes);
// Funciones (Wave 2): Personas, Tarjetas, Recurrentes, Alertas and push subscriptions (all behind the lock).
app.route("/", peopleRoutes);
app.route("/", cardRoutes);
app.route("/", recurringRoutes);
app.route("/", alertRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  // Only the error's own message, never the request, its body or a stack with values in it.
  console.error("server error:", err instanceof Error ? err.message.slice(0, 200) : "unknown");
  return c.json({ error: "server" }, 500);
});

// Only the app may be exported here: Workers treats every export of the main module as an entry point.
// The daily alerts cron (wrangler "triggers") reaches `scheduled` on the same default export; the app's own
// `fetch`, `request` and `routes` stay as they are.
export default Object.assign(app, { scheduled });
