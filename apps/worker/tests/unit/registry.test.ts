// apps/worker/tests/unit/registry.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { registerJob, getJobHandler, registeredJobNames, resetRegistryForTests } from "../../src/jobs/registry.js";

describe("job registry", () => {
  beforeEach(() => resetRegistryForTests());

  it("registers and retrieves a handler by name", () => {
    const handler = async () => "result";
    registerJob("worker.ping", handler);
    expect(getJobHandler("worker.ping")).toBe(handler);
  });

  it("throws on double-registration of the same job name — a silent overwrite would hide a real bug (two modules both claiming the same job name)", () => {
    registerJob("worker.ping", async () => "first");
    expect(() => registerJob("worker.ping", async () => "second")).toThrow(/already registered/);
  });

  it("returns undefined for a valid-but-unregistered name", () => {
    expect(getJobHandler("passport-readiness")).toBeUndefined();
  });

  it("registeredJobNames reflects everything registered so far", () => {
    registerJob("worker.ping", async () => "a");
    registerJob("rfq-expiry", async () => "b");
    expect(registeredJobNames().sort()).toEqual(["rfq-expiry", "worker.ping"]);
  });
});
