import { z } from "zod";
import { query } from "./db.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";

const colorSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  opacity: z.number().min(0).max(1).default(1),
  path: z.string().default(""),
});

const typographySchema = z.object({
  name: z.string().min(1),
  fontFamily: z.string().default("sourcesanspro"),
  fontWeight: z.string().default("400"),
  fontStyle: z.string().default("normal"),
  fontSize: z.string().default("16"),
  lineHeight: z.string().default("1.2"),
  letterSpacing: z.string().default("0"),
  textTransform: z.string().default("none"),
  path: z.string().default(""),
});

export const settingsSchema = z.object({
  general: z
    .object({
      organizationName: z.string().default("Libertariánská strana Voluntia"),
      /** Block creating public share links (view-only links accessible without an account). */
      blockShareLinks: z.boolean().default(false),
    })
    .prefault({}),
  membership: z
    .object({
      /** Every member is added to every team (except excluded ones). */
      autoJoinAllTeams: z.boolean().default(true),
      /** Role used when a member is added to a team. */
      defaultTeamRole: z.enum(["viewer", "editor", "admin"]).default("editor"),
      excludedTeamIds: z.array(z.string()).default([]),
      /** Do not add members to other people's personal ("Your Penpot") teams. */
      skipPersonalTeams: z.boolean().default(true),
      syncIntervalMinutes: z.number().int().min(1).max(1440).default(5),
    })
    .prefault({}),
  onboarding: z
    .object({
      libraryEnabled: z.boolean().default(true),
      libraryName: z.string().default("Voluntia – Brand"),
      /** Name of the project (in each team) that holds the brand library file. */
      libraryProjectName: z.string().default("Brand"),
      palette: z.array(colorSchema).default([
        { name: "Voluntia žlutá", color: "#FFD200", opacity: 1, path: "Brand" },
        { name: "Černá", color: "#1A1A1A", opacity: 1, path: "Brand" },
        { name: "Bílá", color: "#FFFFFF", opacity: 1, path: "Brand" },
        { name: "Šedá", color: "#6B6B6B", opacity: 1, path: "Neutrální" },
      ]),
      typographies: z.array(typographySchema).default([
        {
          name: "Nadpis",
          fontFamily: "sourcesanspro",
          fontWeight: "700",
          fontStyle: "normal",
          fontSize: "48",
          lineHeight: "1.1",
          letterSpacing: "0",
          textTransform: "none",
          path: "Brand",
        },
        {
          name: "Text",
          fontFamily: "sourcesanspro",
          fontWeight: "400",
          fontStyle: "normal",
          fontSize: "16",
          lineHeight: "1.4",
          letterSpacing: "0",
          textTransform: "none",
          path: "Brand",
        },
      ]),
      /** Projects created in every shared team if missing. */
      defaultProjects: z.array(z.string()).default(["Sociální sítě", "Tiskoviny", "Web"]),
      /** Mark the onboarding tutorial / walkthrough as already seen for new users. */
      skipTutorial: z.boolean().default(true),
      /** Link the brand library to files created through the MCP. */
      autoLinkLibrary: z.boolean().default(true),
    })
    .prefault({}),
  ai: z
    .object({
      mcpEnabled: z.boolean().default(true),
      /** When false, the AI can only read designs. */
      writeEnabled: z.boolean().default(true),
      /** null = every team the AI account is a member of. */
      allowedTeamIds: z.array(z.string()).nullable().default(null),
      /** AI access for newly created members. */
      defaultMemberAccess: z.boolean().default(true),
      maxOpenFiles: z.number().int().min(1).max(20).default(4),
      toolTimeoutSeconds: z.number().int().min(10).max(600).default(120),
      extraInstructions: z.string().default(""),
    })
    .prefault({}),
  llm: z
    .object({
      provider: z.enum(["anthropic", "claude-subscription", "openai-compatible"]).default("anthropic"),
      model: z.string().default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      maxTurns: z.number().int().min(1).max(200).default(40),
      anthropicApiKey: z.string().default(""),
      claudeOauthToken: z.string().default(""),
      openaiBaseUrl: z.string().default("https://openrouter.ai/api/v1"),
      openaiApiKey: z.string().default(""),
      openaiModel: z.string().default("anthropic/claude-sonnet-5.5"),
    })
    .prefault({}),
  discord: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().default(""),
      channelIds: z.array(z.string()).default([]),
      allowedRoleIds: z.array(z.string()).default([]),
      respondToMentions: z.boolean().default(true),
      /** Only react when the bot is @mentioned or a message replies to the bot (also in task channels). */
      mentionOnly: z.boolean().default(true),
      useThreads: z.boolean().default(true),
      systemPrompt: z
        .string()
        .default(
          "Jsi grafický asistent Libertariánské strany Voluntia. Pracuješ v Penpotu přes dostupné nástroje. " +
            "Nejdřív pochop, co uživatel chce: na otázku nebo diskusi odpověz (případně navrhni grafiku a zeptej se), " +
            "grafiku vytvářej, jen když o ni jde. Použij všechny konkrétní údaje ze zprávy (datum, místo, médium, jména). " +
            "Přednostně vycházej ze šablon (soubory a boardy „Šablona…“) a drž se brand palety a typografie z knihovny „Voluntia – Brand“. " +
            "Odpovídej česky, stručně; když něco vytvoříš, přidej odkaz na soubor a náhled.",
        ),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;

/** Fields stored encrypted and never sent to the browser in clear text. */
export const SECRET_FIELDS: { [K in SettingsSection]?: (keyof Settings[K])[] } = {
  llm: ["anthropicApiKey", "claudeOauthToken", "openaiApiKey"],
  discord: ["botToken"],
};

export const SECRET_MASK = "••••••••";

let cache: { at: number; value: Settings } | undefined;
const CACHE_MS = 5_000;

export async function getSettings(fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await query<{ key: string; value: any }>("SELECT key, value FROM penpotos.settings");
  const raw: Record<string, any> = {};
  for (const row of rows) raw[row.key] = row.value;
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    for (const f of fields as string[]) {
      const v = raw[section]?.[f];
      if (typeof v === "string" && v) {
        try {
          raw[section][f] = decryptSecret(v);
        } catch {
          raw[section][f] = "";
        }
      }
    }
  }
  const value = settingsSchema.parse(raw);
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Updates one settings section. Secret fields equal to SECRET_MASK keep their stored value.
 */
export async function updateSettings<K extends SettingsSection>(section: K, patch: Partial<Settings[K]>): Promise<Settings> {
  const current = await getSettings(true);
  const merged: any = { ...current[section], ...patch };
  const secretFields = (SECRET_FIELDS[section] ?? []) as string[];
  for (const f of secretFields) {
    if (merged[f] === SECRET_MASK) merged[f] = (current[section] as any)[f];
  }
  const validated: any = settingsSchema.shape[section].parse(merged);
  const stored: any = { ...validated };
  for (const f of secretFields) {
    if (stored[f]) stored[f] = encryptSecret(stored[f]);
  }
  await query(
    `INSERT INTO penpotos.settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [section, JSON.stringify(stored)],
  );
  cache = undefined;
  return getSettings(true);
}

/** Copy of the settings safe to show in the admin UI (secrets masked). */
export function maskSecrets(settings: Settings): Settings {
  const copy: any = structuredClone(settings);
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    for (const f of fields as string[]) {
      if (copy[section][f]) copy[section][f] = SECRET_MASK;
    }
  }
  return copy;
}
