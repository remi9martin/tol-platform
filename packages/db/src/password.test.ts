import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies a correct password against its own hash", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-Staple-1");
    await expect(verifyPassword("Correct-Horse-Battery-Staple-1", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-Staple-1");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("never stores the plaintext in the hash output", async () => {
    const plaintext = "Correct-Horse-Battery-Staple-1";
    const hash = await hashPassword(plaintext);
    expect(hash).not.toContain(plaintext);
    expect(hash.startsWith("$2")).toBe(true); // bcrypt format marker
  });

  it("produces a different hash each time (random salt per call)", async () => {
    const plaintext = "Correct-Horse-Battery-Staple-1";
    const [a, b] = await Promise.all([hashPassword(plaintext), hashPassword(plaintext)]);
    expect(a).not.toBe(b);
  });
});
