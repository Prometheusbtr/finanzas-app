// Types for the tests (the app itself is plain JS).
import type { Statement } from "./parse.js";
export type ApiRow = { fecha: string; comercio: string; cents: number; dir: "out" | "in"; tipo?: "interno" | "ingreso" };
export const CHUNK_ROWS: number;
export const CHUNK_BYTES: number;
export function apiRows(st: Pick<Statement, "rows">): ApiRow[];
export function chunkRows(rows: ApiRow[], opts?: { maxRows?: number; maxBytes?: number }): ApiRow[][];
export function monthsOf(period: { start: string; end: string } | null): string[];
