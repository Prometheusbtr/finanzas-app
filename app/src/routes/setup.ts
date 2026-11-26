import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { svNow } from "../lib/dates.ts";
import { idParam, notFound, readBody } from "../lib/http.ts";
import { centsToPlain, MAX_CENTS } from "../lib/money.ts";
import { assertOwned } from "../lib/owned.ts";
import type { AppEnv } from "../types.ts";

export const setupRoutes = new Hono<AppEnv>();

const name = z.string().trim().min(1).max(60);
const limit = z.number().int().min(0).max(MAX_CENTS).nullable();
const kind = z.enum(["E", "G", "A", "M"]);

/** Run a write and turn a duplicate-name error into a 409. */
async function run(stmt: D1PreparedStatement) {
  try {
    return await stmt.run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HTTPException(409, { message: "name_taken" });
    throw e;
  }
}

function changed(r: D1Result) {
  if (!r.meta.changes) notFound();
}

setupRoutes.post("/groups", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ name, limit_cents: limit.default(null) }));
  const r = await run(
    c.env.DB.prepare(
      `INSERT INTO groups (user_id, name, sort, limit_cents)
       VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM groups WHERE user_id = ?), ?)`,
    ).bind(user.id, b.name, user.id, b.limit_cents),
  );
  return c.json({ id: r.meta.last_row_id }, 201);
});

setupRoutes.put("/groups/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const b = await readBody(c, z.object({ name: name.optional(), limit_cents: limit.optional(), archived: z.boolean().optional() }));
  changed(await run(
    c.env.DB.prepare(
      `UPDATE groups SET name = COALESCE(?, name),
         limit_cents = CASE WHEN ? THEN ? ELSE limit_cents END,
         archived = COALESCE(?, archived)
       WHERE id = ? AND user_id = ?`,
    ).bind(b.name ?? null, b.limit_cents !== undefined ? 1 : 0, b.limit_cents ?? null,
      b.archived === undefined ? null : Number(b.archived), id, user.id),
  ));
  return c.json({ ok: true });
});

setupRoutes.post("/categories", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ group_id: z.number().int().positive(), name, kind, limit_cents: limit.default(null) }));
  await assertOwned(c.env.DB, "groups", b.group_id, user.id);
  const r = await run(
    c.env.DB.prepare(
      `INSERT INTO categories (user_id, group_id, name, kind, limit_cents, sort)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories WHERE user_id = ? AND group_id = ?))`,
    ).bind(user.id, b.group_id, b.name, b.kind, b.limit_cents, user.id, b.group_id),
  );
  return c.json({ id: r.meta.last_row_id }, 201);
});

setupRoutes.put("/categories/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const b = await readBody(c, z.object({
    name: name.optional(), kind: kind.optional(), limit_cents: limit.optional(),
    archived: z.boolean().optional(), group_id: z.number().int().positive().optional(),
  }));
  if (b.group_id) await assertOwned(c.env.DB, "groups", b.group_id, user.id);
  changed(await run(
    c.env.DB.prepare(
      `UPDATE categories SET name = COALESCE(?, name), kind = COALESCE(?, kind),
         limit_cents = CASE WHEN ? THEN ? ELSE limit_cents END,
         archived = COALESCE(?, archived), group_id = COALESCE(?, group_id)
       WHERE id = ? AND user_id = ?`,
    ).bind(b.name ?? null, b.kind ?? null, b.limit_cents !== undefined ? 1 : 0, b.limit_cents ?? null,
      b.archived === undefined ? null : Number(b.archived), b.group_id ?? null, id, user.id),
  ));
  return c.json({ ok: true });
});

const accountKind = z.enum(["tarjeta", "cuenta", "efectivo", "billetera"]);

setupRoutes.post("/accounts", async (c) => {
  const user = c.get("user");
  const b = await readBody(c, z.object({ name, kind: accountKind.default("tarjeta") }));
  const r = await run(
    c.env.DB.prepare(
      `INSERT INTO accounts (user_id, name, kind, sort)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts WHERE user_id = ?))`,
    ).bind(user.id, b.name, b.kind, user.id),
  );
  return c.json({ id: r.meta.last_row_id }, 201);
});

setupRoutes.put("/accounts/:id", async (c) => {
  const user = c.get("user");
  const id = idParam(c);
  const b = await readBody(c, z.object({ name: name.optional(), kind: accountKind.optional(), archived: z.boolean().optional() }));
  changed(await run(
    c.env.DB.prepare(
      `UPDATE accounts SET name = COALESCE(?, name), kind = COALESCE(?, kind), archived = COALESCE(?, archived)
       WHERE id = ? AND user_id = ?`,
    ).bind(b.name ?? null, b.kind ?? null, b.archived === undefined ? null : Number(b.archived), id, user.id),
  ));
  return c.json({ ok: true });
});

const KIND_LABEL: Record<string, string> = { E: "Esencial", G: "Gusto", A: "Ahorro", M: "Mixto" };

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheet apps from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

setupRoutes.get("/export.csv", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.fecha, m.hora, m.amount_cents, m.tipo, m.comercio, a.name AS cuenta, g.name AS grupo, ca.name AS categoria,
         ca.kind, m.tags, m.nota, m.origen, m.estado, m.orig_currency, m.orig_cents
       FROM movements m
       LEFT JOIN accounts a ON a.id = m.account_id
       LEFT JOIN categories ca ON ca.id = m.category_id
       LEFT JOIN groups g ON g.id = ca.group_id
       WHERE m.user_id = ? ORDER BY m.fecha, COALESCE(m.hora, ''), m.id`,
    )
    .bind(user.id)
    .all<Record<string, string | number | null>>();
  const header = ["fecha", "hora", "monto", "tipo", "comercio", "cuenta", "grupo", "categoria", "clase", "etiquetas", "nota", "origen", "estado", "moneda", "monto_moneda"];
  const lines = [header.join(",")];
  for (const r of results) {
    let tags: string[] = [];
    try { tags = JSON.parse(String(r.tags)); } catch { tags = []; }
    lines.push([
      r.fecha, r.hora, centsToPlain(Number(r.amount_cents)), r.tipo, r.comercio, r.cuenta, r.grupo, r.categoria,
      KIND_LABEL[String(r.kind)] ?? "", tags.join("; "), r.nota, r.origen, r.estado,
      r.orig_currency ?? "", r.orig_cents != null ? centsToPlain(Number(r.orig_cents)) : "",
    ].map(csvCell).join(","));
  }
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="finanzas-${svNow().fecha}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
