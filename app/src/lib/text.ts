// Invisible characters that can make a shop name or note look different from what it says
// (direction overrides like "Trojan Source"), plus zero-width and control characters.
// Joiners U+200C/U+200D stay: emoji and some scripts need them. Tab and new lines stay.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

export function cleanText(s: string): string {
  return s.replace(INVISIBLE, "");
}

/** Clean every string inside parsed JSON (objects, arrays, nested). */
export function cleanStrings(v: unknown): unknown {
  if (typeof v === "string") return cleanText(v);
  if (Array.isArray(v)) return v.map(cleanStrings);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cleanStrings(x);
    return out;
  }
  return v;
}
