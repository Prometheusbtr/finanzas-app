// Types for the tests (the app itself is plain JS).
export type Item = { s: string; x: number; y: number; w: number; h: number };
export type Page = { items: Item[] };
export type Cell = { s: string; x: number; end: number };
export type Line = { page: number; y: number; text: string; cells: Cell[] };
export type Row = { fecha: string; comercio: string; cents: number; tipo: "interno" | "ingreso" | null; ref: string; line?: number };
export type Check = {
  ok: boolean | null; label: string; expected?: number | null; got?: number | null; diff?: number | null;
  parts?: Record<string, boolean | null>; credit?: number; line?: number;
};
export type Statement = {
  kind: "agricola_tc" | "uglycash" | "bac_tc" | "csv"; bank: string; card: string | null; cut: string | null;
  period: { start: string; end: string } | null; rows: Row[]; check: Check; summary?: Record<string, unknown>; bad?: number[];
};
export function itemsToLines(pages: Page[]): Line[];
export function centsOf(s: string): number | null;
export function maskDigits(s: string): string;
export function isoDate(y: number, m: number, d: number): string | null;
export function shiftDays(fecha: string, days: number): string;
export function readAgricola(lines: Line[]): Statement;
export function readUglycash(lines: Line[]): Statement;
export function readBac(lines: Line[]): Statement;
export function detect(lines: Line[]): Statement["kind"] | null;
export function readStatement(pages: Page[]): Statement | null;
