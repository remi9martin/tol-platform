// packages/config/src/env.ts
//
// the spec: "Environment variables are parsed once through @tol/config;
// invalid required values fail process startup." This is that one place
// — apps/api reads config exclusively through getConfig() below, never
// process.env directly (outside this file).
//
// Kept dependency-free (no zod) — the validation here is a handful of
// plain string/number checks, not worth pulling in a schema library for.

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  webOrigin: string;
  databaseUrl: string;
  sessionSecret: string;
  logLevel: string;
  // ---- earlier: Lockbox (P9) — ADR-0009. Raw hex strings only; this
  // file does NOT validate their format (64-hex-char/32-byte) — that
  // validation, and the hex-to-Buffer conversion, is @tol/crypto's
  // `parseKeyHex`'s job (called by apps/api's lockbox service), keeping
  // this package's own validation generic ("is it present") rather than
  // crypto-format-aware. Required, no default — acceptance criterion 8:
  // "fail-loud if missing," never a silently-weaker fallback. This is an
  // explicit KMS stand-in (see @tol/crypto/src/keys.ts's own comment) —
  // production would source these from a real KMS/HSM, not process env. ----
  lockboxKekSealer: string;
  lockboxKekOperator: string;
  lockboxKekEscrow: string;
  lockboxReceiptHmacKey: string;
  // ---- earlier: apps/worker (BullMQ/Redis) — P17 Failure-recovery ----
  // required(), not optional-with-fallback: a worker that silently fell
  // back to some default Redis endpoint on a typo'd REDIS_URL would fail
  // in the single worst way for this specific package (connecting to the
  // WRONG Redis, quietly processing nothing, or double-processing against
  // two different queues) — "fail loud at boot" per this file's own
  // stated discipline, not a request-time surprise.
  redisUrl: string;
  /** apps/worker's own health/ready/status HTTP surface port. Optional with a fallback (not required()) — unlike redisUrl, every OTHER app in this repo (apps/api, apps/web) calls getConfig() too and has zero reason to care what port the worker's health server binds to. Falls back to .env's own reserved WORKER_PORT=18500 (see .env.example's port-range comment). */
  workerHealthPort: number;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
}

function requiredPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ConfigError(`Environment variable ${key} must be a valid port number, got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Parses and validates process.env exactly once (at first call);
 * subsequent calls return the same cached object. Throws ConfigError
 * (crashing process startup, not a request handler) on anything missing
 * or malformed — matching the same "fail loud, at boot, not at first use"
 * discipline already applied in packages/db (Prisma's own DATABASE_URL
 * check) and packages/authz (the authority-matrix exhaustiveness check).
 */
let cached: AppConfig | undefined;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const nodeEnvRaw = optional(env, "NODE_ENV", "development");
  if (nodeEnvRaw !== "development" && nodeEnvRaw !== "test" && nodeEnvRaw !== "production") {
    throw new ConfigError(`NODE_ENV must be "development", "test", or "production", got: ${JSON.stringify(nodeEnvRaw)}`);
  }

  const sessionSecret = required(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      `SESSION_SECRET must be at least 32 characters (got ${sessionSecret.length}) — it HMAC-signs session tokens; a short secret is brute-forceable`,
    );
  }

  cached = {
    nodeEnv: nodeEnvRaw,
    isProduction: nodeEnvRaw === "production",
    port: requiredPort(env, "PORT", 4000),
    webOrigin: optional(env, "WEB_ORIGIN", "http://localhost:3000"),
    databaseUrl: required(env, "DATABASE_URL"),
    sessionSecret,
    logLevel: optional(env, "LOG_LEVEL", "info"),
    lockboxKekSealer: required(env, "LOCKBOX_KEK_SEALER"),
    lockboxKekOperator: required(env, "LOCKBOX_KEK_OPERATOR"),
    lockboxKekEscrow: required(env, "LOCKBOX_KEK_ESCROW"),
    lockboxReceiptHmacKey: required(env, "LOCKBOX_RECEIPT_HMAC_KEY"),
    redisUrl: required(env, "REDIS_URL"),
    workerHealthPort: requiredPort(env, "WORKER_PORT", 18500),
  };
  return cached;
}

/** Test-only escape hatch — clears the cache so a test can call getConfig() again with a different fake `env`. */
export function resetConfigCacheForTests(): void {
  cached = undefined;
}
