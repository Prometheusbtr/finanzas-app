// Types for the tests (the app itself is plain JS).
import type { Statement } from "./parse.js";
export const MAX_CSV_BYTES: number;
export const MAX_CSV_ROWS: number;
export type Table = { header: string[]; rows: string[][]; delimiter: string };
export type CsvMap = {
  fecha: number | null; comercio: number | null; monto: number | null; cargo: number | null; abono: number | null; saldo: number | null;
  order: "dmy" | "mdy" | "ymd"; sign: "out_positive" | "out_negative";
};
export function parseCsv(text: string, opts?: { maxRows?: number }): Table;
export function headerText(header: string[]): string;
export function amountCents(text: string): number | null;
export function dateOf(text: string, order: CsvMap["order"]): string | null;
export function guessMap(header: string[], rows: string[][]): CsvMap;
export function readCsv(table: Table, map: CsvMap): Statement;
