import { describe, expect, it, vi } from "vitest";

vi.mock("@penpotos/shared", async () => ({
  audit: vi.fn(),
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  env: {},
  getSettings: vi.fn(async () => ({ general: { blockShareLinks: true } })),
  INTERNAL_HEADER: "x-penpotos-internal",
}));

const { isBlocked, isMcpPath, rpcCommandOf } = await import("../services/core/src/gateway.ts");

describe("gateway", () => {
  it("extracts RPC command names from both URL styles", () => {
    expect(rpcCommandOf("/api/rpc/command/register-profile")).toBe("register-profile");
    expect(rpcCommandOf("/api/main/methods/get-file?id=1")).toBe("get-file");
    expect(rpcCommandOf("/assets/by-id/x")).toBeUndefined();
  });

  it("blocks self-registration through the public entrypoint", async () => {
    expect(await isBlocked("/api/rpc/command/prepare-register-profile")).toMatch(/Registrace/);
    expect(await isBlocked("/api/main/methods/register-profile?x=1")).toMatch(/Registrace/);
    expect(await isBlocked("/api/main/methods/login-with-password")).toBeUndefined();
  });

  it("blocks share links when configured", async () => {
    expect(await isBlocked("/api/main/methods/create-share-link")).toMatch(/odkazy/);
  });

  it("routes MCP and OAuth paths to the MCP service", () => {
    for (const p of ["/mcp", "/mcp?x", "/authorize?client_id=1", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/penpotos-auth/login"]) {
      expect(isMcpPath(p), p).toBe(true);
    }
    for (const p of ["/", "/api/main/methods/get-profile", "/js/config.js", "/registerx", "/#/auth/register"]) {
      expect(isMcpPath(p), p).toBe(false);
    }
  });
});

describe("gateway header hygiene", async () => {
  const { stripInternalHeaders } = await import("../services/core/src/gateway.ts");
  it("drops service-to-service headers from external requests", () => {
    const h: Record<string, string> = { "x-penpotos-internal": "secret", "x-penpotos-actor": "a", authorization: "Bearer x" };
    stripInternalHeaders(h);
    expect(h).toEqual({ authorization: "Bearer x" });
  });
});

describe("public address helpers", async () => {
  const { normalizePublicUrl } = await import("../services/core/src/admin/setup.ts");
  it("normalises typed addresses", () => {
    expect(normalizePublicUrl("penpot.voluntia.cz")).toBe("https://penpot.voluntia.cz");
    expect(normalizePublicUrl("192.168.0.98:9001")).toBe("http://192.168.0.98:9001");
    expect(normalizePublicUrl("https://penpot.voluntia.cz/")).toBe("https://penpot.voluntia.cz");
    expect(() => normalizePublicUrl("https://x.cz/penpot")).toThrow();
  });
});

describe("setup wizard tokens", async () => {
  const { isValidSetupToken } = await import("../services/core/src/admin/setup.ts");
  it("rejects unknown or empty tokens", () => {
    expect(isValidSetupToken("")).toBe(false);
    expect(isValidSetupToken("not-issued")).toBe(false);
  });
});
