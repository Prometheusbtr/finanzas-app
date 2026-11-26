// Response headers and request limits for the API (Seguridad owns this file).

export const MAX_BODY_BYTES = 64 * 1024;

/** Sent on every API response, errors included. The static files get theirs from public/_headers. */
export const API_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export function withSecurityHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(API_HEADERS)) res.headers.set(k, v);
  return res;
}

