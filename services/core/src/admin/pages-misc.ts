import { Router } from "express";
import { env, listActiveTokens, listProfiles, listTeams, recentAudit } from "@penpotos/shared";
import { allStatuses } from "../status.ts";
import { getLastSyncReport } from "../sync.ts";
import { esc, fmtDate, html, layout, raw } from "./html.ts";
import { endSession, requireAdmin, startSession, takeFlash, verifyAdminCredentials } from "./session.ts";

export const publicRouter = Router();
export const miscRouter = Router();

function safeNext(v: unknown) {
  const s = String(v ?? "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

const loginPage = (next: string, error?: string) =>
  layout(
    { title: "Přihlášení" },
    html`<div class="login card">
      <h1><span class="logo">◆</span> PenpotOS admin</h1>
      ${error ? html`<div class="flash error">${error}</div>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label>E-mail</label><input type="email" name="email" required autofocus>
        <label>Heslo</label><input type="password" name="password" required>
        <div class="actions"><button class="primary">Přihlásit</button></div>
      </form>
      <p class="hint">Přihlas se svým Penpot účtem s rolí administrátora.</p>
    </div>`,
  );

publicRouter.get("/login", (req, res) => {
  res.send(loginPage(safeNext(req.query.next)));
});

const attempts = new Map<string, { n: number; until: number }>();

publicRouter.post("/login", async (req, res) => {
  const ip = req.ip ?? "?";
  const a = attempts.get(ip);
  if (a && a.until > Date.now() && a.n >= 5) {
    return res.status(429).send(loginPage(safeNext(req.body.next), "Příliš mnoho pokusů, zkus to za pár minut."));
  }
  try {
    const row = await verifyAdminCredentials(String(req.body.email ?? ""), String(req.body.password ?? ""));
    attempts.delete(ip);
    startSession(req, res, row.id);
    res.redirect(safeNext(req.body.next));
  } catch (err: any) {
    const cur = a && a.until > Date.now() ? a : { n: 0, until: Date.now() + 10 * 60_000 };
    cur.n++;
    attempts.set(ip, cur);
    const msg = err?.status === 400 || err?.code === "wrong-credentials" ? "Neplatný e-mail nebo heslo." : err.message;
    res.status(401).send(loginPage(safeNext(req.body.next), msg));
  }
});

publicRouter.post("/logout", (req, res) => {
  endSession(res);
  res.redirect("/login");
});

const dot = (ok: boolean) => raw(ok ? '<span class="badge ok">OK</span>' : '<span class="badge err">chyba</span>');

miscRouter.get("/", async (req, res) => {
  const [profiles, teams, tokens, st] = await Promise.all([listProfiles(), listTeams(), listActiveTokens(), allStatuses()]);
  const report = getLastSyncReport();
  const members = profiles.filter((p) => !p.isService);
  const body = html`
    <h1>Přehled</h1>
    <div class="grid">
      <div class="card"><div class="muted">Uživatelé</div><div class="stat">${members.length}</div><div class="muted">${members.filter((p) => p.isBlocked).length} blokovaných</div></div>
      <div class="card"><div class="muted">Týmy</div><div class="stat">${teams.filter((t) => !t.isDefault).length}</div><div class="muted">+ ${teams.filter((t) => t.isDefault).length} osobních</div></div>
      <div class="card"><div class="muted">Aktivní AI přístupy</div><div class="stat">${tokens.length}</div><div class="muted">OAuth + API tokeny</div></div>
    </div>
    <div class="card">
      <h2>Stav služeb</h2>
      <table>
        <tr><td>Penpot backend</td><td>${dot(st.penpot.ok)}</td><td class="muted">${st.penpot.detail}</td></tr>
        <tr><td>Správa účtů (PREPL)</td><td>${dot(st.prepl.ok)}</td><td class="muted">${st.prepl.detail}</td></tr>
        <tr><td>MCP server</td><td>${dot(st.mcp.ok)}</td><td class="muted">${st.mcp.detail}</td></tr>
        <tr><td>Discord bot</td><td>${dot(st.discord.ok)}</td><td class="muted">${st.discord.detail}</td></tr>
      </table>
      <p class="muted">Poslední synchronizace týmů: ${report ? fmtDate(report.at) : "zatím ne"}</p>
    </div>
    <div class="card">
      <h2>Adresy</h2>
      <p>Penpot pro členy: <a href="${env.publicUrl}" target="_blank">${env.publicUrl}</a></p>
      <p>MCP connector pro Claude: <code>${env.publicUrl}/mcp</code></p>
    </div>`;
  res.send(layout({ title: "Přehled", active: "/", user: req.admin, csrf: req.admin!.csrf, flash: takeFlash(req, res) }, body));
});

const SOURCES = [
  ["", "Vše"],
  ["admin", "Admin"],
  ["mcp", "MCP"],
  ["discord", "Discord"],
  ["system", "Systém"],
];

miscRouter.get("/audit", async (req, res) => {
  const source = typeof req.query.source === "string" && req.query.source ? req.query.source : undefined;
  const rows = await recentAudit(300, source);
  const body = html`
    <h1>Audit log</h1>
    <p>${SOURCES.map(([v, l]) => html`<a class="btn ${(source ?? "") === v ? "primary" : ""}" href="/audit${v ? `?source=${v}` : ""}">${l}</a> `)}</p>
    <div class="card table-wrap"><table>
      <thead><tr><th>Čas</th><th>Zdroj</th><th>Kdo</th><th>Akce</th><th>Cíl</th><th>Výsledek</th><th>Detail</th></tr></thead>
      <tbody>${rows.map(
        (r: any) => html`<tr><td class="muted">${fmtDate(r.ts)}</td><td>${r.source}</td><td>${r.actor ?? "–"}</td><td>${r.action}</td>
          <td class="mono">${r.target ?? ""}</td><td>${r.ok ? raw('<span class="badge ok">ok</span>') : raw('<span class="badge err">chyba</span>')}${r.durationMs != null ? ` ${r.durationMs} ms` : ""}</td>
          <td>${r.detail ? html`<details><summary>…</summary><pre class="mono">${JSON.stringify(r.detail, null, 2).slice(0, 4000)}</pre></details>` : ""}</td></tr>`,
      )}</tbody>
    </table></div>`;
  res.send(layout({ title: "Audit log", active: "/audit", user: req.admin, csrf: req.admin!.csrf }, body));
});

export { requireAdmin, esc };
