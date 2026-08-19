// packages/queue/tests/setup.ts — loads the repo-root .env before any
// test file runs, same reasoning as apps/api/apps/worker's own
// tests/setup.ts: @tol/config's getConfig() reads process.env directly
// (no automatic .env discovery, unlike Prisma's own tooling), so without
// this, any test that touches getProducerConnection()/enqueue*() throws
// "Missing required environment variable: REDIS_URL".

import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env on disk — assume CI/the environment already injected what's needed.
}
