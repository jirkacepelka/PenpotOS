import { Router } from "express";
import {
  SECRET_MASK,
  audit,
  env,
  getSettings,
  listActiveTokens,
  listTeams,
  maskSecrets,
  revokeTokenHash,
  updateSettings,
} from "@penpotos/shared";
import { discordStatus, mcpStatus } from "../status.ts";
import { csrfField, fmtDate, html, layout, raw } from "./html.ts";
import { arr } from "./pages-onboarding.ts";
import { setFlash, takeFlash } from "./session.ts";

export const aiRouter = Router();

const statusBadge = (s: { ok: boolean; detail: string }) =>
  s.ok ? html`<span class="badge ok">běží</span> <span class="muted">${s.detail}</span>` : html`<span class="badge err">nedostupné</span> <span class="muted">${s.detail}</span>`;

aiRouter.get("/ai", async (req, res) => {
  const [settings, teams, tokens, mcp] = await Promise.all([getSettings(), listTeams(), listActiveTokens(), mcpStatus()]);
  const ai = settings.ai;
  const csrf = req.admin!.csrf;
  const allTeams = ai.allowedTeamIds === null;
  const mcpUrl = `${env.publicUrl}/mcp`;
  const body = html`
    <h1>AI & MCP</h1>
    <div class="card">
      <h2>Připojení z Claude chatu</h2>
      <p>Stav MCP serveru: ${statusBadge(mcp)}</p>
      <p>URL connectoru: <code>${mcpUrl}</code> <button data-copy="${mcpUrl}">Kopírovat</button></p>
      <ol>
        <li>V Claude (web/desktop/mobil): <strong>Nastavení → Connectors → Add custom connector</strong>.</li>
        <li>Název např. „Penpot Voluntia“, URL výše, potvrdit.</li>
        <li>Claude otevře přihlašovací stránku PenpotOS – člen se přihlásí svým Penpot účtem (musí mít povolené AI).</li>
        <li>V chatu pak stačí napsat např. „V Penpotu v týmu Kampaň vytvoř plakát…“.</li>
      </ol>
      <p class="hint">MCP musí být dostupné přes HTTPS z internetu (Cloudflare Tunnel). Pro Claude Desktop/Code lze místo OAuth použít API token (u uživatele).</p>
      ${mcp.data?.browser ? html`<p class="muted">Headless prohlížeč: ${mcp.data.browser.connected ? "připojen" : "nespuštěn"}, otevřené soubory: ${mcp.data.browser.openFiles ?? 0}</p>` : ""}
    </div>
    <form method="post" action="/ai" class="card">
      ${csrfField(csrf)}
      <h2>Oprávnění AI (platí pro MCP i Discord bota)</h2>
      <label class="inline"><input type="checkbox" name="mcpEnabled" ${ai.mcpEnabled ? "checked" : ""}> AI integrace zapnutá</label>
      <label class="inline"><input type="checkbox" name="writeEnabled" ${ai.writeEnabled ? "checked" : ""}> AI smí upravovat a vytvářet návrhy (jinak jen čtení)</label>
      <label class="inline"><input type="checkbox" name="defaultMemberAccess" ${ai.defaultMemberAccess ? "checked" : ""}> Noví členové mají AI přístup automaticky</label>
      <label>Týmy, ke kterým má AI přístup</label>
      <label class="inline"><input type="radio" name="teamScope" value="all" ${allTeams ? "checked" : ""}> Všechny týmy (globální přístup)</label>
      <label class="inline"><input type="radio" name="teamScope" value="selected" ${allTeams ? "" : "checked"}> Jen vybrané:</label>
      <div>${teams
        .filter((t) => !t.isDefault)
        .map(
          (t) => html`<label class="inline"><input type="checkbox" name="allowedTeamIds" value="${t.id}" ${!allTeams && ai.allowedTeamIds!.includes(t.id) ? "checked" : ""}> ${t.name}</label>`,
        )}</div>
      <div class="row">
        <div><label>Max. současně otevřených souborů</label><input type="number" name="maxOpenFiles" min="1" max="20" value="${ai.maxOpenFiles}"></div>
        <div><label>Časový limit nástroje (s)</label><input type="number" name="toolTimeoutSeconds" min="10" max="600" value="${ai.toolTimeoutSeconds}"></div>
      </div>
      <label>Doplňující instrukce pro AI (přidají se k instrukcím MCP serveru)</label>
      <textarea name="extraInstructions" placeholder="např. Vždy používej barvy z knihovny Voluntia – Brand. Texty piš česky.">${ai.extraInstructions}</textarea>
      <div class="actions"><button class="primary">Uložit</button></div>
    </form>
    <div class="card table-wrap">
      <h2>Aktivní MCP přístupy</h2>
      <table>
        <thead><tr><th>Uživatel</th><th>Typ</th><th>Název / klient</th><th>Vytvořeno</th><th>Naposledy</th><th></th></tr></thead>
        <tbody>${tokens.map(
          (t) => html`<tr><td>${t.fullname ?? "–"} <span class="muted">${t.email ?? ""}</span></td>
            <td>${t.kind === "api" ? "API token" : "OAuth"}</td><td>${t.name ?? t.clientId ?? "–"}</td>
            <td>${fmtDate(t.createdAt)}</td><td>${fmtDate(t.lastUsedAt)}</td>
            <td><form method="post" action="/tokens/${t.tokenHash}/revoke">${csrfField(csrf)}<input type="hidden" name="back" value="/ai"><button class="link">Zrušit</button></form></td></tr>`,
        )}</tbody>
      </table>
    </div>`;
  res.send(layout({ title: "AI & MCP", active: "/ai", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

aiRouter.post("/ai", async (req, res) => {
  try {
    const b = req.body;
    await updateSettings("ai", {
      mcpEnabled: b.mcpEnabled === "on",
      writeEnabled: b.writeEnabled === "on",
      defaultMemberAccess: b.defaultMemberAccess === "on",
      allowedTeamIds: b.teamScope === "selected" ? arr(b.allowedTeamIds) : null,
      maxOpenFiles: Number(b.maxOpenFiles) || 4,
      toolTimeoutSeconds: Number(b.toolTimeoutSeconds) || 120,
      extraInstructions: String(b.extraInstructions ?? ""),
    });
    await audit({ source: "admin", actor: req.admin!.email, action: "settings.ai" });
    setFlash(res, "ok", "Uloženo.");
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect("/ai");
});

aiRouter.post("/tokens/:hash/revoke", async (req, res) => {
  await revokeTokenHash(req.params.hash);
  await audit({ source: "admin", actor: req.admin!.email, action: "token.revoke", target: req.params.hash.slice(0, 12) });
  setFlash(res, "ok", "Přístup zrušen.");
  const back = String(req.body.back ?? "/ai");
  res.redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/ai");
});

const MODELS = [
  ["claude-opus-5-5", "Claude Opus 5.5 (nejlepší kvalita)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (rychlejší, levnější)"],
  ["claude-fable-5-1", "Claude Fable 5.1 (nejschopnější, nejdražší)"],
  ["claude-haiku-4-5", "Claude Haiku 4.5 (nejlevnější)"],
];

aiRouter.get("/integrations", async (req, res) => {
  const [settings, discord] = await Promise.all([getSettings(), discordStatus()]);
  const s = maskSecrets(settings);
  const csrf = req.admin!.csrf;
  const llm = s.llm;
  const d = s.discord;
  const body = html`
    <h1>Discord bot & AI model</h1>
    <form method="post" action="/integrations/llm" class="card">
      ${csrfField(csrf)}
      <h2>AI model pro Discord bota</h2>
      <label>Poskytovatel</label>
      <select name="provider">
        <option value="anthropic" ${llm.provider === "anthropic" ? "selected" : ""}>Anthropic API (API klíč, platba za použití) – doporučeno</option>
        <option value="claude-subscription" ${llm.provider === "claude-subscription" ? "selected" : ""}>Claude předplatné (Pro/Max přes Claude Agent SDK)</option>
        <option value="openai-compatible" ${llm.provider === "openai-compatible" ? "selected" : ""}>OpenAI-kompatibilní (OpenRouter, Ollama, OpenAI…)</option>
      </select>
      <div class="row">
        <div><label>Claude model</label><select name="model">${MODELS.map(
          ([id, label]) => html`<option value="${id}" ${llm.model === id ? "selected" : ""}>${label}</option>`,
        )}${MODELS.some(([id]) => id === llm.model) ? "" : html`<option value="${llm.model}" selected>${llm.model}</option>`}</select></div>
        <div><label>Úsilí (effort)</label><select name="effort">${["low", "medium", "high", "xhigh", "max"].map(
          (e) => html`<option value="${e}" ${llm.effort === e ? "selected" : ""}>${e}</option>`,
        )}</select></div>
        <div><label>Max. kroků na úkol</label><input type="number" name="maxTurns" min="1" max="200" value="${llm.maxTurns}"></div>
      </div>
      <details ${llm.provider === "anthropic" ? "open" : ""}><summary>Anthropic API</summary>
        <label>API klíč (console.anthropic.com)</label><input type="password" name="anthropicApiKey" value="${llm.anthropicApiKey}" placeholder="sk-ant-..." autocomplete="off">
      </details>
      <details ${llm.provider === "claude-subscription" ? "open" : ""}><summary>Claude předplatné</summary>
        <label>OAuth token (výstup příkazu <code>claude setup-token</code>)</label><input type="password" name="claudeOauthToken" value="${llm.claudeOauthToken}" placeholder="sk-ant-oat..." autocomplete="off">
        <p class="hint">⚠️ Podmínky Anthropicu nepovolují zpřístupňovat přihlášení/limity předplatného claude.ai dalším lidem přes vlastní produkty. Bot sdílený více členy na tvém osobním předplatném je proto šedá zóna – použití je na tvou odpovědnost. Pro bezpečný provoz doporučujeme API klíč. Členové, kteří používají AI přes Claude chat (connector), využívají vlastní předplatné bez omezení.</p>
      </details>
      <details ${llm.provider === "openai-compatible" ? "open" : ""}><summary>OpenAI-kompatibilní API</summary>
        <div class="row">
          <div><label>Base URL</label><input type="url" name="openaiBaseUrl" value="${llm.openaiBaseUrl}"></div>
          <div><label>Model</label><input type="text" name="openaiModel" value="${llm.openaiModel}"></div>
        </div>
        <label>API klíč</label><input type="password" name="openaiApiKey" value="${llm.openaiApiKey}" autocomplete="off">
      </details>
      <div class="actions"><button class="primary">Uložit model</button></div>
    </form>
    <form method="post" action="/integrations/discord" class="card">
      ${csrfField(csrf)}
      <h2>Discord bot</h2>
      <p>Stav: ${statusBadge(discord)}</p>
      <label class="inline"><input type="checkbox" name="enabled" ${d.enabled ? "checked" : ""}> Bot zapnutý</label>
      <label>Bot token (Discord Developer Portal → Bot → Reset Token)</label>
      <input type="password" name="botToken" value="${d.botToken}" autocomplete="off">
      <div class="row">
        <div><label>ID kanálů pro úkoly (oddělené čárkou)</label><input type="text" name="channelIds" value="${d.channelIds.join(", ")}"></div>
        <div><label>ID rolí, které smí zadávat úkoly (prázdné = všichni v kanálu)</label><input type="text" name="allowedRoleIds" value="${d.allowedRoleIds.join(", ")}"></div>
      </div>
      <label class="inline"><input type="checkbox" name="useThreads" ${d.useThreads ? "checked" : ""}> Každý úkol řešit ve vlastním vláknu</label>
      <label class="inline"><input type="checkbox" name="respondToMentions" ${d.respondToMentions ? "checked" : ""}> Reagovat i na @zmínku v jiných kanálech</label>
      <label>Systémový prompt</label>
      <textarea name="systemPrompt">${d.systemPrompt}</textarea>
      <p class="hint">Bot potřebuje v Developer Portalu zapnuté „Message Content Intent“ a oprávnění: Read/Send Messages, Create Public Threads, Send Messages in Threads, Attach Files.</p>
      <div class="actions"><button class="primary">Uložit Discord</button></div>
    </form>`;
  res.send(layout({ title: "Discord & model", active: "/integrations", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

const ids = (v: unknown) =>
  String(v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,30}$/.test(s));

aiRouter.post("/integrations/llm", async (req, res) => {
  try {
    const b = req.body;
    await updateSettings("llm", {
      provider: b.provider,
      model: String(b.model ?? "claude-opus-5-5"),
      effort: b.effort,
      maxTurns: Number(b.maxTurns) || 40,
      anthropicApiKey: String(b.anthropicApiKey ?? SECRET_MASK),
      claudeOauthToken: String(b.claudeOauthToken ?? SECRET_MASK),
      openaiBaseUrl: String(b.openaiBaseUrl ?? ""),
      openaiApiKey: String(b.openaiApiKey ?? SECRET_MASK),
      openaiModel: String(b.openaiModel ?? ""),
    });
    await audit({ source: "admin", actor: req.admin!.email, action: "settings.llm", detail: { provider: b.provider, model: b.model } });
    setFlash(res, "ok", "Uloženo.");
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect("/integrations");
});

aiRouter.post("/integrations/discord", async (req, res) => {
  try {
    const b = req.body;
    await updateSettings("discord", {
      enabled: b.enabled === "on",
      botToken: String(b.botToken ?? SECRET_MASK),
      channelIds: ids(b.channelIds),
      allowedRoleIds: ids(b.allowedRoleIds),
      useThreads: b.useThreads === "on",
      respondToMentions: b.respondToMentions === "on",
      systemPrompt: String(b.systemPrompt ?? ""),
    });
    await audit({ source: "admin", actor: req.admin!.email, action: "settings.discord" });
    setFlash(res, "ok", "Uloženo. Bot převezme nastavení do několika sekund.");
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect("/integrations");
});
