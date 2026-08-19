import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one real docker-compose Postgres and
    // create their own uniquely-suffixed fixtures rather than relying on
    // DB-level isolation between files — safe to parallelize across
    // files, but keep it explicit rather than accidentally depending on
    // vitest's default.
    fileParallelism: true,
    testTimeout: 15_000,
  },
});
