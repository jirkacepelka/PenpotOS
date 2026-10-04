import { describe, expect, it } from "vitest";
import { apiInfo, apiTypeNames, highLevelOverview } from "../services/mcp/src/docs.ts";

describe("vendored Penpot MCP documentation", () => {
  it("loads the API types", () => {
    expect(apiTypeNames()).toContain("Penpot");
    expect(apiInfo("shape")).toMatch(/Shape/);
    expect(apiInfo("NoSuchType")).toMatch(/not found/);
  });

  it("adapts the overview to the headless multi-file setup", () => {
    const text = highLevelOverview("Používej brand barvy.");
    expect(text).not.toMatch(/Penpot MCP Plugin/);
    expect(text).toMatch(/fileId/);
    expect(text).not.toContain("$api_types");
    expect(text).toMatch(/Používej brand barvy/);
  });
});
