export function shellOf(sw: string): { cache: string | null; modules: string[]; shell: string[] };
export function cspOf(headers: string): string | null;
export function checkShell(o: {
  swText: string;
  headersText: string;
  liveSwText: string;
  liveCsp: string | null;
  readLocal: (path: string) => Promise<Uint8Array>;
  fetchLive: (path: string) => Promise<Uint8Array>;
}): Promise<{ status: "broken" | "new" | "same" | "changed"; liveCache: string | null; changed: string[] }>;
