import { describe, expect, it } from "vitest";
import { splitMessage, taskText } from "../services/discord/src/bot.ts";
import { toolLabel } from "../services/discord/src/providers/types.ts";

describe("discord helpers", () => {
  it("removes the bot mention from the task", () => {
    expect(taskText("<@123> udělej plakát", "123")).toBe("udělej plakát");
    expect(taskText("ahoj <@!123>", "123")).toBe("ahoj");
  });

  it("splits long answers below the Discord limit", () => {
    const text = Array.from({ length: 300 }, (_, i) => `řádek ${i} s nějakým textem`).join("\n");
    const parts = splitMessage(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    expect(parts.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("labels MCP tools in Czech, also with the Agent SDK prefix", () => {
    expect(toolLabel("export_shape")).toBe("exportuji náhled");
    expect(toolLabel("mcp__penpot__execute_code")).toBe("upravuji návrh");
  });
});
