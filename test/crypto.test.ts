import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.PENPOTOS_SECRET_KEY = "test-secret-key-0123456789";
});

const { decryptSecret, encryptSecret, generatePassword, hmac, safeEqual } = await import("../packages/shared/src/crypto.ts");

describe("crypto", () => {
  it("round-trips encrypted secrets", () => {
    const enc = encryptSecret("sk-ant-secret");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("sk-ant-secret");
    expect(decryptSecret(enc)).toBe("sk-ant-secret");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("value");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("generates passwords of the requested length without ambiguous characters", () => {
    const p = generatePassword(20);
    expect(p).toHaveLength(20);
    expect(p).not.toMatch(/[0O1lI]/);
  });

  it("signs values deterministically", () => {
    expect(safeEqual(hmac("a"), hmac("a"))).toBe(true);
    expect(safeEqual(hmac("a"), hmac("b"))).toBe(false);
  });
});
