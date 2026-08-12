import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken, normalizeLoginName } from "@/lib/auth/token";

describe("session token", () => {
  it("creates unique 256-bit opaque tokens", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
  });
  it("stores only a deterministic SHA-256 hash", () => {
    const token = createSessionToken();
    const hashed = hashSessionToken(token);
    expect(hashed).toHaveLength(64);
    expect(hashed).not.toContain(token);
  });
  it("normalizes width, whitespace, and case", () => {
    expect(normalizeLoginName("  ＡＤＭＩＮ  ")).toBe("admin");
  });
});
