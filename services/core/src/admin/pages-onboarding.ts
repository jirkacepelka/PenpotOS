import { Router } from "express";
import { audit, getSettings, getState, listTeams, updateSettings } from "@penpotos/shared";
import { invalidateBrandLibraries, runSync } from "../sync.ts";
import { csrfField, html, layout } from "./html.ts";
import { setFlash, takeFlash } from "./session.ts";

export const onboardingRouter = Router();

export function arr(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

const colorRow = (c: { name: string; color: string; path: string }) => html`<div class="editor-row">
  <input type="color" value="${c.color}">
  <input type="text" name="palette_name" value="${c.name}" placeholder="Název barvy" required>
  <input type="text" name="palette_path" value="${c.path}" placeholder="Skupina (nepovinné)">
  <input type="text" name="palette_color" value="${c.color}" data-hex pattern="#[0-9A-Fa-f]{6}" required>
  <button data-remove-row title="Odebrat">✕</button>
</div>`;

const typoRow = (t: any) => html`<div class="editor-row typo">
  <input type="text" name="typo_name" value="${t.name}" placeholder="Název stylu" required>
  <input type="text" name="typo_fontFamily" value="${t.fontFamily}" placeholder="Font (např. sourcesanspro)">
  <input type="text" name="typo_fontWeight" value="${t.fontWeight}" placeholder="Váha">
  <input type="text" name="typo_fontSize" value="${t.fontSize}" placeholder="Velikost">
  <input type="text" name="typo_lineHeight" value="${t.lineHeight}" placeholder="Řádkování">
  <input type="text" name="typo_path" value="${t.path}" placeholder="Skupina">
  <button data-remove-row title="Odebrat">✕</button>
</div>`;

onboardingRouter.get("/onboarding", async (req, res) => {
  const s = await getSettings();
  const o = s.onboarding;
  const csrf = req.admin!.csrf;
  const libs = (await getState<Record<string, { fileId: string }>>("brand-libraries")) ?? {};
  const teams = await listTeams();
  const body = html`
    <h1>Výchozí nastavení pro členy a týmy</h1>
    <form method="post" action="/onboarding">
      ${csrfField(csrf)}
      <div class="card">
        <h2>Brand knihovna</h2>
        <label class="inline"><input type="checkbox" name="libraryEnabled" ${o.libraryEnabled ? "checked" : ""}> Udržovat v každém týmu sdílenou knihovnu s paletou a typografií</label>
        <div class="row">
          <div><label>Název knihovny</label><input type="text" name="libraryName" value="${o.libraryName}" required></div>
          <div><label>Projekt, ve kterém knihovna je</label><input type="text" name="libraryProjectName" value="${o.libraryProjectName}" required></div>
        </div>
        <label class="inline"><input type="checkbox" name="autoLinkLibrary" ${o.autoLinkLibrary ? "checked" : ""}> Soubory vytvořené přes AI automaticky propojit s knihovnou</label>
        <p class="hint">Penpot sdílí knihovny v rámci týmu – PenpotOS proto knihovnu vytvoří a aktualizuje v každém týmu. Členové ji v souboru připojí přes „Knihovny → Propojit“.</p>
      </div>
      <div class="card">
        <h2>Paleta barev</h2>
        <div id="palette">${o.palette.map(colorRow)}</div>
        <template id="palette-tpl">${colorRow({ name: "", color: "#000000", path: "" })}</template>
        <button data-add-row="palette-tpl" data-target="palette">+ Přidat barvu</button>
      </div>
      <div class="card">
        <h2>Typografie</h2>
        <div id="typos">${o.typographies.map(typoRow)}</div>
        <template id="typo-tpl">${typoRow({ name: "", fontFamily: "sourcesanspro", fontWeight: "400", fontSize: "16", lineHeight: "1.2", path: "" })}</template>
        <button data-add-row="typo-tpl" data-target="typos">+ Přidat styl</button>
        <p class="hint">Font family je ID fontu v Penpotu (vestavěné např. <code>sourcesanspro</code>, Google fonty např. <code>gfont-roboto</code>, vlastní fonty týmu dle jejich ID).</p>
      </div>
      <div class="card">
        <h2>Struktura týmů a noví členové</h2>
        <label>Výchozí projekty v každém týmu (jeden na řádek)</label>
        <textarea name="defaultProjects">${o.defaultProjects.join("\n")}</textarea>
        <label class="inline"><input type="checkbox" name="skipTutorial" ${o.skipTutorial ? "checked" : ""}> Novým členům přeskočit úvodní tutoriál Penpotu</label>
      </div>
      <div class="actions"><button class="primary">Uložit a aplikovat na všechny týmy</button></div>
    </form>
    <div class="card mt">
      <h2>Stav knihoven</h2>
      <ul>${teams
        .filter((t) => libs[t.id])
        .map((t) => html`<li>${t.name}: soubor <code>${libs[t.id].fileId}</code></li>`)}</ul>
      <form method="post" action="/sync">${csrfField(csrf)}<button>Synchronizovat teď</button></form>
    </div>`;
  res.send(layout({ title: "Výchozí nastavení", active: "/onboarding", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

onboardingRouter.post("/onboarding", async (req, res) => {
  try {
    const b = req.body;
    const names = arr(b.palette_name);
    const colors = arr(b.palette_color);
    const paths = arr(b.palette_path);
    const palette = names
      .map((name, i) => ({ name: name.trim(), color: (colors[i] ?? "").trim().toUpperCase(), path: (paths[i] ?? "").trim(), opacity: 1 }))
      .filter((c) => c.name);
    const tNames = arr(b.typo_name);
    const typographies = tNames
      .map((name, i) => ({
        name: name.trim(),
        fontFamily: arr(b.typo_fontFamily)[i]?.trim() || "sourcesanspro",
        fontWeight: arr(b.typo_fontWeight)[i]?.trim() || "400",
        fontStyle: "normal",
        fontSize: arr(b.typo_fontSize)[i]?.trim() || "16",
        lineHeight: arr(b.typo_lineHeight)[i]?.trim() || "1.2",
        letterSpacing: "0",
        textTransform: "none",
        path: arr(b.typo_path)[i]?.trim() ?? "",
      }))
      .filter((t) => t.name);
    await updateSettings("onboarding", {
      libraryEnabled: b.libraryEnabled === "on",
      libraryName: String(b.libraryName ?? "").trim() || "Brand",
      libraryProjectName: String(b.libraryProjectName ?? "").trim() || "Brand",
      autoLinkLibrary: b.autoLinkLibrary === "on",
      skipTutorial: b.skipTutorial === "on",
      palette,
      typographies,
      defaultProjects: String(b.defaultProjects ?? "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    await invalidateBrandLibraries();
    await audit({ source: "admin", actor: req.admin!.email, action: "settings.onboarding", detail: { colors: palette.length, typographies: typographies.length } });
    runSync("onboarding-changed").catch(() => {});
    setFlash(res, "ok", "Uloženo. Knihovny a projekty se aktualizují na pozadí (stav uvidíš v Týmech).");
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect("/onboarding");
});
