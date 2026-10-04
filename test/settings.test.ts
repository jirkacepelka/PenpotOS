import { describe, expect, it } from "vitest";
import { SECRET_MASK, maskSecrets, settingsSchema } from "../packages/shared/src/settings.ts";

describe("settings", () => {
  it("fills every section with defaults", () => {
    const s = settingsSchema.parse({});
    expect(s.membership.autoJoinAllTeams).toBe(true);
    expect(s.ai.allowedTeamIds).toBeNull();
    expect(s.onboarding.palette.length).toBeGreaterThan(0);
    expect(s.llm.model).toBe("claude-opus-5-5");
  });

  it("validates palette colours", () => {
    expect(() => settingsSchema.parse({ onboarding: { palette: [{ name: "x", color: "red" }] } })).toThrow();
  });

  it("masks secrets for the browser", () => {
    const s = settingsSchema.parse({ llm: { anthropicApiKey: "sk-ant-x" }, discord: { botToken: "tok" } });
    const m = maskSecrets(s);
    expect(m.llm.anthropicApiKey).toBe(SECRET_MASK);
    expect(m.discord.botToken).toBe(SECRET_MASK);
    expect(m.llm.openaiApiKey).toBe("");
    expect(s.llm.anthropicApiKey).toBe("sk-ant-x");
  });
});
