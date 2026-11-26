// Types for numbers.js, so the tests can call it.
export function parseCents(input: unknown, opts?: { max?: number; zero?: boolean }): number | null;
export const isZero: (s: unknown) => boolean;
export function parseRate(input: unknown, currency: string): { rate?: number | null; error?: string; x?: string };
