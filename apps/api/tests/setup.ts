// apps/api/tests/setup.ts — loads the repo-root .env before any test
// file runs, same as server.ts does for a real process boot. Without
// this, @tol/config's getConfig() throws "Missing required environment
// variable: SESSION_SECRET" the instant any test imports app.ts, since
// vitest never goes through server.ts's own env-loading step.

import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env on disk — assume CI/the environment already injected what's needed.
}
