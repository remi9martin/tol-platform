import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one real docker-compose Redis + Postgres
    // (same convention as apps/api/vitest.config.ts) — safe to
    // parallelize across files, kept explicit rather than relying on
    // vitest's default.
    fileParallelism: true,
    testTimeout: 20_000,
  },
});
