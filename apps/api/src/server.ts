// apps/api/src/server.ts — process entry point. Everything else composes
// in app.ts; this file only boots it and wires shutdown.

import { fileURLToPath } from "node:url";
import { getConfig } from "@tol/config";
import { buildApp } from "./app.js";

// Loads the repo-root .env into process.env before @tol/config reads it —
// @tol/config deliberately only reads process.env (the spec), it never
// parses a dotenv file itself. Resolved relative to this file's own
// location (not CWD), so `pnpm --filter @tol/api run dev` works
// identically regardless of which directory it's invoked from. Silently
// continues if the file is absent — a real deployment sets env vars
// through its platform, not a checked-in .env.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env on disk — assume the environment already has what it needs
  // (getConfig() below still fails loudly if anything required is missing).
}

async function main() {
  const config = getConfig();
  const app = await buildApp();

  // Fastify 5 requires the object form of listen() — the variadic
  // (port, host) signature from v4 was removed.
  await app.listen({ port: config.port, host: "0.0.0.0" });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
