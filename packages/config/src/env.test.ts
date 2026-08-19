import { describe, expect, it, beforeEach } from "vitest";
import { getConfig, resetConfigCacheForTests } from "./env.js";

function fakeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    SESSION_SECRET: "a".repeat(32),
    DATABASE_URL: "postgresql://tol:changeme@localhost:5432/tol_platform",
    // earlier: required for every test in this file, same reasoning as
    // SESSION_SECRET/DATABASE_URL above — real format validation
    // (64-hex-char/32-byte) happens in @tol/crypto's parseKeyHex, not
    // here, so any non-empty placeholder string satisfies THIS file's
    // "is it present" check; dedicated malformed-hex cases belong in
    // @tol/crypto's own keys.test.ts, not this one.
    LOCKBOX_KEK_SEALER: "a".repeat(64),
    LOCKBOX_KEK_OPERATOR: "b".repeat(64),
    LOCKBOX_KEK_ESCROW: "c".repeat(64),
    LOCKBOX_RECEIPT_HMAC_KEY: "d".repeat(64),
    // earlier: required for every test in this file, same reasoning as
    // SESSION_SECRET/DATABASE_URL/LOCKBOX_* above.
    REDIS_URL: "redis://localhost:6379",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("getConfig()", () => {
  beforeEach(() => resetConfigCacheForTests());

  it("loads valid config with sane defaults for optional values", () => {
    const config = getConfig(fakeEnv());
    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(4000);
    expect(config.isProduction).toBe(false);
  });

  it("fails loudly (throws) when SESSION_SECRET is missing — not a silent default", () => {
    expect(() => getConfig(fakeEnv({ SESSION_SECRET: undefined }))).toThrow(/SESSION_SECRET/);
  });

  it("fails loudly when SESSION_SECRET is too short to be a real secret", () => {
    expect(() => getConfig(fakeEnv({ SESSION_SECRET: "short" }))).toThrow(/at least 32 characters/);
  });

  it("fails loudly when DATABASE_URL is missing", () => {
    expect(() => getConfig(fakeEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
  });

  it("rejects a malformed NODE_ENV instead of silently accepting it", () => {
    expect(() => getConfig(fakeEnv({ NODE_ENV: "prod" }))).toThrow(/NODE_ENV/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => getConfig(fakeEnv({ PORT: "not-a-number" }))).toThrow(/PORT/);
  });

  it("caches after the first call — a second call with different env still returns the first result", () => {
    const first = getConfig(fakeEnv({ PORT: "5000" }));
    const second = getConfig(fakeEnv({ PORT: "6000" }));
    expect(second.port).toBe(first.port);
  });

  describe("earlier: Lockbox KEKs / receipt HMAC key (acceptance criterion 8 — fail loud, no default)", () => {
    it("loads all 4 required Lockbox key strings when present", () => {
      const config = getConfig(fakeEnv());
      expect(config.lockboxKekSealer).toBe("a".repeat(64));
      expect(config.lockboxKekOperator).toBe("b".repeat(64));
      expect(config.lockboxKekEscrow).toBe("c".repeat(64));
      expect(config.lockboxReceiptHmacKey).toBe("d".repeat(64));
    });

    it("fails loudly when LOCKBOX_KEK_SEALER is missing — never a silent weaker default", () => {
      expect(() => getConfig(fakeEnv({ LOCKBOX_KEK_SEALER: undefined }))).toThrow(/LOCKBOX_KEK_SEALER/);
    });

    it("fails loudly when LOCKBOX_KEK_OPERATOR is missing", () => {
      expect(() => getConfig(fakeEnv({ LOCKBOX_KEK_OPERATOR: undefined }))).toThrow(/LOCKBOX_KEK_OPERATOR/);
    });

    it("fails loudly when LOCKBOX_KEK_ESCROW is missing", () => {
      expect(() => getConfig(fakeEnv({ LOCKBOX_KEK_ESCROW: undefined }))).toThrow(/LOCKBOX_KEK_ESCROW/);
    });

    it("fails loudly when LOCKBOX_RECEIPT_HMAC_KEY is missing", () => {
      expect(() => getConfig(fakeEnv({ LOCKBOX_RECEIPT_HMAC_KEY: undefined }))).toThrow(/LOCKBOX_RECEIPT_HMAC_KEY/);
    });
  });

  describe("earlier: apps/worker Redis connection (fail loud, no default — see this file's header comment)", () => {
    it("loads REDIS_URL when present", () => {
      const config = getConfig(fakeEnv());
      expect(config.redisUrl).toBe("redis://localhost:6379");
    });

    it("fails loudly when REDIS_URL is missing — never a silent fallback to some default Redis endpoint", () => {
      expect(() => getConfig(fakeEnv({ REDIS_URL: undefined }))).toThrow(/REDIS_URL/);
    });

    it("workerHealthPort falls back to 18500 when WORKER_PORT is unset (unlike REDIS_URL, this one has a real default — apps/api/apps/web don't care what port the worker's health server binds to)", () => {
      const config = getConfig(fakeEnv());
      expect(config.workerHealthPort).toBe(18500);
    });

    it("workerHealthPort honors an explicit WORKER_PORT", () => {
      const config = getConfig(fakeEnv({ WORKER_PORT: "19999" }));
      expect(config.workerHealthPort).toBe(19999);
    });

    it("rejects a non-numeric WORKER_PORT", () => {
      expect(() => getConfig(fakeEnv({ WORKER_PORT: "not-a-number" }))).toThrow(/WORKER_PORT/);
    });
  });
});
