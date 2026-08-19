// apps/worker/tests/setup.ts — loads the repo-root .env before any test
// file runs, identical reasoning to apps/api/tests/setup.ts: without
// this, @tol/config's getConfig() throws "Missing required environment
// variable: REDIS_URL" the instant any test imports something that calls
// getConfig(), since vitest never goes through server.ts's own
// env-loading step.

import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env on disk — assume CI/the environment already injected what's needed.
}
