import type { Settings } from "@penpotos/shared";
import { browserPool } from "./browser.ts";

type Onboarding = Settings["onboarding"];

/**
 * Writes the configured palette and typographies into the local library of a
 * (shared library) file. Elements created by PenpotOS are tagged with shared
 * plugin data so that removed entries can be cleaned up without touching
 * elements added manually by designers.
 */
export async function applyBrandLibrary(fileId: string, palette: Onboarding["palette"], typographies: Onboarding["typographies"]) {
  const code = `
    const NS = "penpotos";
    const lib = penpot.library.local;
    const isManaged = (el) => { try { return el.getSharedPluginData(NS, "managed") === "1"; } catch { return false; } };
    const keyOf = (name, path) => (path || "") + "/" + name;
    const report = { colorsCreated: 0, colorsUpdated: 0, colorsRemoved: 0, typographiesCreated: 0, typographiesUpdated: 0, typographiesRemoved: 0, warnings: [] };

    const wantedColors = ${JSON.stringify(palette)};
    const wantedColorKeys = new Set(wantedColors.map((c) => keyOf(c.name, c.path)));
    for (const c of wantedColors) {
      let el = lib.colors.find((x) => keyOf(x.name, x.path) === keyOf(c.name, c.path));
      if (!el) { el = lib.createColor(); report.colorsCreated++; } else { report.colorsUpdated++; }
      el.name = c.name;
      el.path = c.path || "";
      el.color = c.color;
      el.opacity = c.opacity ?? 1;
      el.setSharedPluginData(NS, "managed", "1");
    }
    for (const el of [...lib.colors]) {
      if (isManaged(el) && !wantedColorKeys.has(keyOf(el.name, el.path)) && typeof el.remove === "function") { el.remove(); report.colorsRemoved++; }
    }

    const wantedTypos = ${JSON.stringify(typographies)};
    const wantedTypoKeys = new Set(wantedTypos.map((t) => keyOf(t.name, t.path)));
    for (const t of wantedTypos) {
      let el = lib.typographies.find((x) => keyOf(x.name, x.path) === keyOf(t.name, t.path));
      if (!el) { el = lib.createTypography(); report.typographiesCreated++; } else { report.typographiesUpdated++; }
      el.name = t.name;
      el.path = t.path || "";
      const font = penpot.fonts.findById(t.fontFamily) || penpot.fonts.findByName(t.fontFamily);
      if (font) {
        const variant = (font.variants || []).find((v) => String(v.fontWeight) === String(t.fontWeight) && (v.fontStyle || "normal") === (t.fontStyle || "normal"));
        el.setFont(font, variant || undefined);
      } else {
        report.warnings.push("Font not found: " + t.fontFamily);
      }
      el.fontSize = String(t.fontSize);
      el.lineHeight = String(t.lineHeight);
      el.letterSpacing = String(t.letterSpacing);
      if (t.textTransform && t.textTransform !== "none") el.textTransform = t.textTransform;
      el.setSharedPluginData(NS, "managed", "1");
    }
    for (const el of [...lib.typographies]) {
      if (isManaged(el) && !wantedTypoKeys.has(keyOf(el.name, el.path)) && typeof el.remove === "function") { el.remove(); report.typographiesRemoved++; }
    }
    return report;`;
  const outcome = await browserPool.exec(fileId, code, { admin: true, storageKey: "penpotos-admin", timeoutMs: 180_000 });
  if (!outcome.ok) throw new Error(outcome.error ?? "brand library update failed");
  return outcome.result;
}
