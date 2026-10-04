import { Router } from "express";
import {
  addTeamMember,
  getProfile,
  getSettings,
  issueToken,
  listProfiles,
  listTeams,
  profileTeamIds,
  query,
  env,
} from "@penpotos/shared";
import { createMember, deleteMember, resetPassword, setBlocked, updateMember } from "../members.ts";
import { runSync } from "../sync.ts";
import { csrfField, fmtDate, html, layout, raw } from "./html.ts";
import { setFlash, takeFlash } from "./session.ts";

export const usersRouter = Router();

function bool(v: unknown) {
  return v === "on" || v === "true" || v === "1";
}

usersRouter.get("/users", async (req, res) => {
  const profiles = await listProfiles();
  const settings = await getSettings();
  const body = html`
    <h1>Uživatelé</h1>
    <div class="card">
      <h2>Přidat uživatele</h2>
      <form method="post" action="/users">
        ${csrfField(req.admin!.csrf)}
        <div class="row">
          <div><label>Jméno a příjmení</label><input type="text" name="fullname" required></div>
          <div><label>E-mail (přihlašovací)</label><input type="email" name="email" required></div>
          <div><label>Heslo</label><input type="text" name="password" placeholder="prázdné = vygenerovat" minlength="8"></div>
          <div><label>Role</label><select name="role"><option value="member">Člen</option><option value="admin">Administrátor</option></select></div>
        </div>
        <label class="inline"><input type="checkbox" name="aiAccess" ${settings.ai.defaultMemberAccess ? "checked" : ""}> Smí používat AI (MCP z Claude chatu)</label>
        <p class="hint">Uživatel bude automaticky přidán do všech týmů${settings.membership.autoJoinAllTeams ? "" : " (auto-join je vypnutý)"} a uvidí brand knihovnu s výchozí paletou.</p>
        <div class="actions"><button class="primary">Vytvořit účet</button></div>
      </form>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Jméno</th><th>E-mail</th><th>Role</th><th>Týmy</th><th>AI</th><th>Stav</th><th>Vytvořen</th><th></th></tr></thead>
        <tbody>
        ${profiles.map(
          (p) => html`<tr>
            <td><a href="/users/${p.id}">${p.fullname}</a></td>
            <td class="muted">${p.email}</td>
            <td>${p.isService ? raw('<span class="badge accent">AI účet</span>') : p.role === "admin" ? raw('<span class="badge accent">admin</span>') : p.managed ? "člen" : raw('<span class="badge">nespravovaný</span>')}</td>
            <td>${p.teamCount}</td>
            <td>${p.isService ? "–" : p.aiAccess ? raw('<span class="badge ok">ano</span>') : raw('<span class="badge">ne</span>')}</td>
            <td>${p.isBlocked ? raw('<span class="badge err">blokován</span>') : raw('<span class="badge ok">aktivní</span>')}</td>
            <td class="muted">${fmtDate(p.createdAt)}</td>
            <td><a href="/users/${p.id}">Upravit</a></td>
          </tr>`,
        )}
        </tbody>
      </table>
    </div>`;
  res.send(layout({ title: "Uživatelé", active: "/users", user: req.admin, csrf: req.admin!.csrf, flash: takeFlash(req, res) }, body));
});

function credentialsPage(req: any, title: string, email: string, password: string, publicUrl: string) {
  const text = `Penpot: ${publicUrl}\nE-mail: ${email}\nHeslo: ${password}`;
  return layout(
    { title, active: "/users", user: req.admin, csrf: req.admin.csrf },
    html`<h1>${title}</h1>
      <div class="card">
        <p>Předej uživateli tyto údaje (heslo se zobrazuje jen teď):</p>
        <div class="secret-box">Penpot: ${publicUrl}<br>E-mail: ${email}<br>Heslo: <strong>${password}</strong></div>
        <div class="actions"><button data-copy="${text}">Zkopírovat</button><a class="btn" href="/users">Zpět na uživatele</a></div>
        <p class="hint">Uživatel si heslo může změnit v Penpotu (Nastavení → Heslo).</p>
      </div>`,
  );
}

usersRouter.post("/users", async (req, res) => {
  try {
    const { password, profileId } = await createMember(
      {
        fullname: String(req.body.fullname ?? ""),
        email: String(req.body.email ?? ""),
        password: String(req.body.password ?? ""),
        role: req.body.role === "admin" ? "admin" : "member",
        aiAccess: bool(req.body.aiAccess),
      },
      req.admin!.email,
    );
    runSync("member-created").catch(() => {});
    const profile = await getProfile(profileId);
    res.send(credentialsPage(req, "Účet vytvořen", profile!.email, password, env.publicUrl));
  } catch (err: any) {
    setFlash(res, "error", err.message);
    res.redirect("/users");
  }
});

usersRouter.get("/users/:id", async (req, res) => {
  const p = await getProfile(req.params.id);
  if (!p) return res.status(404).send("Nenalezeno");
  const teams = await listTeams();
  const memberOf = new Set(await profileTeamIds(p.id));
  const tokens = await query(
    `SELECT token_hash AS "tokenHash", kind, name, client_id AS "clientId", created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
       FROM penpotos.tokens WHERE profile_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND kind <> 'oauth_access'
      ORDER BY created_at DESC`,
    [p.id],
  );
  const csrf = req.admin!.csrf;
  const body = html`
    <p><a href="/users">← Uživatelé</a></p>
    <h1>${p.fullname} ${p.isBlocked ? raw('<span class="badge err">blokován</span>') : ""}</h1>
    <div class="grid">
      <div class="card">
        <h2>Údaje</h2>
        <form method="post" action="/users/${p.id}">
          ${csrfField(csrf)}
          <label>Jméno</label><input type="text" name="fullname" value="${p.fullname}" required>
          <label>E-mail</label><input type="email" value="${p.email}" disabled>
          ${p.isService
            ? html`<p class="hint">Servisní účet, pod kterým AI upravuje návrhy. Spravuje se automaticky.</p>`
            : html`<label>Role</label>
              <select name="role">
                <option value="member" ${p.role !== "admin" ? "selected" : ""}>Člen</option>
                <option value="admin" ${p.role === "admin" ? "selected" : ""}>Administrátor</option>
              </select>
              <label class="inline"><input type="checkbox" name="aiAccess" ${p.aiAccess ? "checked" : ""}> Smí používat AI (MCP)</label>`}
          <div class="actions"><button class="primary">Uložit</button></div>
        </form>
      </div>
      ${p.isService
        ? ""
        : html`<div class="card">
        <h2>Zabezpečení</h2>
        <form method="post" action="/users/${p.id}/password">
          ${csrfField(csrf)}
          <label>Nové heslo</label><input type="text" name="password" placeholder="prázdné = vygenerovat" minlength="8">
          <div class="actions"><button>Nastavit heslo</button></div>
        </form>
        <div class="actions">
          <form method="post" action="/users/${p.id}/${p.isBlocked ? "unblock" : "block"}">${csrfField(csrf)}
            <button class="${p.isBlocked ? "" : "danger"}">${p.isBlocked ? "Odblokovat" : "Zablokovat přístup"}</button></form>
          <form method="post" action="/users/${p.id}/delete">${csrfField(csrf)}
            <button class="danger" data-confirm="Opravdu smazat účet ${p.email}? Jeho soubory v osobním týmu budou smazány.">Smazat účet</button></form>
        </div>
      </div>`}
    </div>
    <div class="card">
      <h2>Týmy</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Tým</th><th>Člen</th><th></th></tr></thead>
        <tbody>${teams
          .filter((t) => !t.isDefault || memberOf.has(t.id))
          .map(
            (t) => html`<tr><td><a href="/teams/${t.id}">${t.name}</a> ${t.isDefault ? raw('<span class="badge">osobní</span>') : ""}</td>
              <td>${memberOf.has(t.id) ? raw('<span class="badge ok">ano</span>') : raw('<span class="badge">ne</span>')}</td>
              <td>${memberOf.has(t.id)
                ? ""
                : html`<form method="post" action="/users/${p.id}/join/${t.id}">${csrfField(csrf)}<button class="link">Přidat do týmu</button></form>`}</td></tr>`,
          )}</tbody>
      </table></div>
    </div>
    ${p.isService
      ? ""
      : html`<div class="card">
      <h2>MCP přístupy</h2>
      <p class="hint">OAuth připojení vznikají automaticky, když se uživatel připojí z Claude chatu. API token se hodí pro Claude Desktop / Claude Code / jiné MCP klienty.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Typ</th><th>Název / klient</th><th>Vytvořen</th><th>Naposledy použit</th><th></th></tr></thead>
        <tbody>${tokens.map(
          (t: any) => html`<tr><td>${t.kind === "api" ? "API token" : "OAuth (Claude apod.)"}</td><td>${t.name ?? t.clientId ?? "–"}</td>
            <td>${fmtDate(t.createdAt)}</td><td>${fmtDate(t.lastUsedAt)}</td>
            <td><form method="post" action="/tokens/${t.tokenHash}/revoke">${csrfField(csrf)}<input type="hidden" name="back" value="/users/${p.id}"><button class="link">Zrušit</button></form></td></tr>`,
        )}</tbody>
      </table></div>
      <form method="post" action="/users/${p.id}/tokens" class="row mt">
        ${csrfField(csrf)}
        <div><label>Nový API token – název</label><input type="text" name="name" placeholder="např. Claude Desktop notebook" required></div>
        <div class="shrink"><button>Vytvořit token</button></div>
      </form>
    </div>`}`;
  res.send(layout({ title: p.fullname, active: "/users", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

function wrap(fn: (req: any, res: any) => Promise<string | void>, back?: (req: any) => string) {
  return async (req: any, res: any) => {
    try {
      const msg = await fn(req, res);
      if (res.headersSent) return;
      if (msg) setFlash(res, "ok", msg);
    } catch (err: any) {
      setFlash(res, "error", err.message);
    }
    if (!res.headersSent) res.redirect(back ? back(req) : `/users/${req.params.id}`);
  };
}

usersRouter.post(
  "/users/:id",
  wrap(async (req) => {
    const p = await getProfile(req.params.id);
    await updateMember(
      req.params.id,
      p?.isService
        ? { fullname: String(req.body.fullname) }
        : { fullname: String(req.body.fullname), role: req.body.role === "admin" ? "admin" : "member", aiAccess: bool(req.body.aiAccess) },
      req.admin.email,
    );
    return "Uloženo.";
  }),
);

usersRouter.post("/users/:id/password", async (req, res) => {
  try {
    const pwd = await resetPassword(req.params.id, req.admin!.email, String(req.body.password ?? ""));
    const p = await getProfile(req.params.id);
    res.send(credentialsPage(req, "Heslo změněno", p!.email, pwd, env.publicUrl));
  } catch (err: any) {
    setFlash(res, "error", err.message);
    res.redirect(`/users/${req.params.id}`);
  }
});

usersRouter.post("/users/:id/block", wrap(async (req) => (await setBlocked(req.params.id, true, req.admin.email), "Účet zablokován, přihlášení zrušeno.")));
usersRouter.post("/users/:id/unblock", wrap(async (req) => (await setBlocked(req.params.id, false, req.admin.email), "Účet odblokován.")));
usersRouter.post(
  "/users/:id/delete",
  wrap(
    async (req) => (await deleteMember(req.params.id, req.admin.email), "Účet smazán."),
    () => "/users",
  ),
);
usersRouter.post(
  "/users/:id/join/:teamId",
  wrap(async (req) => {
    const settings = await getSettings();
    const p = await getProfile(req.params.id);
    await addTeamMember(req.params.teamId, req.params.id, p?.role === "admin" ? "admin" : settings.membership.defaultTeamRole);
    return "Přidáno do týmu.";
  }),
);

usersRouter.post("/users/:id/tokens", async (req, res) => {
  const p = await getProfile(req.params.id);
  if (!p) return res.status(404).send("Nenalezeno");
  if (!p.aiAccess) {
    setFlash(res, "error", "Uživatel nemá povolený přístup k AI.");
    return res.redirect(`/users/${p.id}`);
  }
  const { token } = await issueToken({ kind: "api", profileId: p.id, name: String(req.body.name || "API token") });
  const url = `${env.publicUrl}/mcp`;
  const config = JSON.stringify({ mcpServers: { penpot: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  res.send(
    layout(
      { title: "API token", active: "/users", user: req.admin, csrf: req.admin!.csrf },
      html`<h1>Nový API token pro ${p.fullname}</h1>
      <div class="card">
        <p>Token se zobrazuje jen teď. MCP URL: <code>${url}</code></p>
        <div class="secret-box">${token}</div>
        <div class="actions"><button data-copy="${token}">Zkopírovat token</button></div>
        <h2>Konfigurace pro Claude Desktop / Claude Code</h2>
        <pre class="secret-box">${config}</pre>
        <div class="actions"><button data-copy="${config}">Zkopírovat konfiguraci</button><a class="btn" href="/users/${p.id}">Zpět</a></div>
      </div>`,
    ),
  );
});
