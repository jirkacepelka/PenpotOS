import { describe, expect, it, vi } from "vitest";

vi.mock("@penpotos/shared", () => ({
  audit: vi.fn(),
  botCall: vi.fn(),
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  env: {},
  fileTeamId: vi.fn(),
  getSettings: vi.fn(),
  getState: vi.fn(),
  workspaceUrl: vi.fn(),
}));
vi.mock("../services/mcp/src/browser.ts", () => ({ AccessDeniedError: Error, browserPool: {} }));

const { isPrivateAddress } = await import("../services/mcp/src/tools.ts");

describe("import_image SSRF guard", () => {
  it("detects internal addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.18.0.5", "192.168.1.10", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["162.159.130.233", "8.8.8.8", "2606:4700::6810:84e5", "172.32.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
