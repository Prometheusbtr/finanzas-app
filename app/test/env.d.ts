declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

// Vite features the tests use (test/sw-shell.test.ts): a file's text, and the list of files matching a pattern.
declare module "*?raw" {
  const text: string;
  export default text;
}
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
