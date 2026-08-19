import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("newId (UUIDv7)", () => {
  it("produces a well-formed UUID string", () => {
    expect(newId()).toMatch(UUID_RE);
  });

  it("sets the version nibble to 7", () => {
    const id = newId();
    expect(id[14]).toBe("7");
  });

  it("sets the variant bits to one of 8/9/a/b", () => {
    const id = newId();
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("is unique across many calls", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId()));
    expect(ids.size).toBe(2000);
  });

  it("sorts lexicographically in (roughly) creation order", async () => {
    const first = newId();
    await new Promise((r) => setTimeout(r, 5));
    const second = newId();
    expect(first < second).toBe(true);
  });
});
