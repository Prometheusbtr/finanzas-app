import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { cleanStrings } from "./text.ts";

/** Read and validate a JSON body, with invisible direction characters removed from every string.
 * Throws a 400 the error handler turns into {"error": ...}. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "bad_json" });
  }
  const r = schema.safeParse(cleanStrings(data));
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HTTPException(400, { message: `invalid:${first?.path.join(".") || "body"}` });
  }
  return r.data;
}

export function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(404, { message: "not_found" });
  return id;
}

export function notFound(): never {
  throw new HTTPException(404, { message: "not_found" });
}
