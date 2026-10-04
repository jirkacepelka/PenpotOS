import { Router } from "express";
import {
  addTeamMember,
  audit,
  getSettings,
  getTeam,
  listProfiles,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  setTeamMemberRole,
  updateSettings,
} from "@penpotos/shared";
import { getLastSyncReport, runSync } from "../sync.ts";
import { csrfField, fmtDate, html, layout, raw } from "./html.ts";
import { setFlash, takeFlash } from "./session.ts";

export const teamsRouter = Router();

const ROLE_LABEL: Record<string, string> = { viewer: "Prohlížející", editor: "Editor", admin: "Admin týmu" };

teamsRouter.get("/teams", async (req, res) => {
  const [teams, settings] = await Promise.all([listTeams(), getSettings()]);
  const m = settings.membership;
  const csrf = req.admin!.csrf;
  const report = getLastSyncReport();
  const body = html`
    <h1>Týmy</h1>
    <div class="card">
      <h2>Pravidla členství</h2>
      <form method="post" action="/teams/settings">
        ${csrfField(csrf)}
        <label class="inline"><input type="checkbox" name="autoJoinAllTeams" ${m.autoJoinAllTeams ? "checked" : ""}> Každý člen je automaticky ve všech týmech</label>
        <label class="inline"><input type="checkbox" name="skipPersonalTeams" ${m.skipPersonalTeams ? "checked" : ""}> Vynechat osobní týmy („Your Penpot“) ostatních</label>
        <div class="row">
          <div><label>Výchozí role v týmu</label>
            <select name="defaultTeamRole">${(["viewer", "editor", "admin"] as const).map(
              (r) => html`<option value="${r}" ${m.defaultTeamRole === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`,
            )}</select></div>
          <div><label>Interval synchronizace (minuty)</label><input type="number" name="syncIntervalMinutes" min="1" max="1440" value="${m.syncIntervalMinutes}"></div>
        </div>
        <p class="hint">Administrátoři PenpotOS dostávají v týmech roli „Admin týmu“. AI účet je vždy ve všech týmech (globální přístup AI) – omezení se nastavuje v sekci AI & MCP.</p>
        <div class="actions"><button class="primary">Uložit</button></div>
      </form>
      <form method="post" action="/sync" class="actions">${csrfField(csrf)}<button>Synchronizovat teď</button>
        <span class="muted">${report
          ? `Poslední synchronizace ${fmtDate(report.at)} – přidáno členství: ${report.membershipsAdded}, projekty: ${report.projectsCreated}, knihovny: ${report.librariesUpdated}${report.errors.length ? `, chyby: ${report.errors.length}` : ""}`
          : "Synchronizace ještě neproběhla."}</span></form>
      ${report?.errors.length ? html`<details><summary>Chyby poslední synchronizace</summary><ul>${report.errors.map((e) => html`<li>${e}</li>`)}</ul></details>` : ""}
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Tým</th><th>Vlastník</th><th>Členů</th><th>Automatické členství</th><th></th></tr></thead>
        <tbody>${teams.map((t) => {
          const excluded = m.excludedTeamIds.includes(t.id);
          const auto = !excluded && !(m.skipPersonalTeams && t.isDefault);
          return html`<tr>
            <td><a href="/teams/${t.id}">${t.isDefault ? `${t.name} (osobní)` : t.name}</a></td>
            <td class="muted">${t.ownerName ?? "–"}</td>
            <td>${t.memberCount}</td>
            <td>${auto ? raw('<span class="badge ok">ano</span>') : raw('<span class="badge">ne</span>')}</td>
            <td><form method="post" action="/teams/${t.id}/${excluded ? "include" : "exclude"}">${csrfField(csrf)}
              <button class="link">${excluded ? "Zahrnout do automatiky" : "Vyjmout z automatiky"}</button></form></td>
          </tr>`;
        })}</tbody>
      </table>
    </div>`;
  res.send(layout({ title: "Týmy", active: "/teams", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

teamsRouter.post("/teams/settings", async (req, res) => {
  try {
    await updateSettings("membership", {
      autoJoinAllTeams: req.body.autoJoinAllTeams === "on",
      skipPersonalTeams: req.body.skipPersonalTeams === "on",
      defaultTeamRole: req.body.defaultTeamRole,
      syncIntervalMinutes: Number(req.body.syncIntervalMinutes) || 5,
    });
    await audit({ source: "admin", actor: req.admin!.email, action: "settings.membership" });
    setFlash(res, "ok", "Uloženo.");
    runSync("settings").catch(() => {});
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect("/teams");
});

teamsRouter.post("/sync", async (req, res) => {
  try {
    const r = await runSync("manual");
    setFlash(
      res,
      r.errors.length ? "error" : "ok",
      `Synchronizace hotová: ${r.teams} týmů, nových členství ${r.membershipsAdded}, projektů ${r.projectsCreated}, knihoven ${r.librariesUpdated}.` +
        (r.errors.length ? `\nChyby:\n${r.errors.join("\n")}` : ""),
    );
  } catch (err: any) {
    setFlash(res, "error", err.message);
  }
  res.redirect(req.get("referer")?.includes("/onboarding") ? "/onboarding" : "/teams");
});

async function toggleExcluded(teamId: string, exclude: boolean) {
  const s = await getSettings(true);
  const set = new Set(s.membership.excludedTeamIds);
  exclude ? set.add(teamId) : set.delete(teamId);
  await updateSettings("membership", { excludedTeamIds: [...set] });
}

teamsRouter.post("/teams/:id/exclude", async (req, res) => {
  await toggleExcluded(req.params.id, true);
  setFlash(res, "ok", "Tým vyjmut z automatického členství (stávající členové zůstávají).");
  res.redirect("/teams");
});
teamsRouter.post("/teams/:id/include", async (req, res) => {
  await toggleExcluded(req.params.id, false);
  runSync("team-included").catch(() => {});
  setFlash(res, "ok", "Tým zahrnut do automatického členství.");
  res.redirect("/teams");
});

teamsRouter.get("/teams/:id", async (req, res) => {
  const team = await getTeam(req.params.id);
  if (!team) return res.status(404).send("Nenalezeno");
  const [members, profiles] = await Promise.all([listTeamMembers(team.id), listProfiles()]);
  const memberIds = new Set(members.map((m) => m.profileId));
  const csrf = req.admin!.csrf;
  const role = (m: { isOwner: boolean; isAdmin: boolean; canEdit: boolean }) =>
    m.isOwner ? "owner" : m.isAdmin ? "admin" : m.canEdit ? "editor" : "viewer";
  const body = html`
    <p><a href="/teams">← Týmy</a></p>
    <h1>${team.name}</h1>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Člen</th><th>E-mail</th><th>Role</th><th></th></tr></thead>
        <tbody>${members.map(
          (m) => html`<tr><td>${m.fullname}</td><td class="muted">${m.email}</td>
          <td>${m.isOwner
            ? "Vlastník"
            : html`<form method="post" action="/teams/${team.id}/members/${m.profileId}/role" class="row">${csrfField(csrf)}
              <select name="role" data-autosubmit>${(["viewer", "editor", "admin"] as const).map(
                (r) => html`<option value="${r}" ${role(m) === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`,
              )}</select><button class="link">Uložit</button></form>`}</td>
          <td>${m.isOwner ? "" : html`<form method="post" action="/teams/${team.id}/members/${m.profileId}/remove">${csrfField(csrf)}<button class="link" data-confirm="Odebrat ${m.fullname} z týmu? (Při zapnutém auto-join bude znovu přidán – tým nejdřív vyjmi z automatiky.)">Odebrat</button></form>`}</td></tr>`,
        )}</tbody>
      </table>
      <form method="post" action="/teams/${team.id}/members" class="row mt">
        ${csrfField(csrf)}
        <div><label>Přidat člena</label><select name="profileId">${profiles
          .filter((p) => !memberIds.has(p.id) && !p.isBlocked)
          .map((p) => html`<option value="${p.id}">${p.fullname} (${p.email})</option>`)}</select></div>
        <div><label>Role</label><select name="role">${(["viewer", "editor", "admin"] as const).map((r) => html`<option value="${r}" ${r === "editor" ? "selected" : ""}>${ROLE_LABEL[r]}</option>`)}</select></div>
        <div class="shrink"><button>Přidat</button></div>
      </form>
    </div>`;
  res.send(layout({ title: team.name, active: "/teams", user: req.admin, csrf, flash: takeFlash(req, res) }, body));
});

const ROLES = new Set(["viewer", "editor", "admin"]);

teamsRouter.post("/teams/:id/members", async (req, res) => {
  const role = ROLES.has(req.body.role) ? req.body.role : "editor";
  await addTeamMember(req.params.id, String(req.body.profileId), role);
  await audit({ source: "admin", actor: req.admin!.email, action: "team.add-member", target: req.params.id, detail: { profileId: req.body.profileId, role } });
  setFlash(res, "ok", "Člen přidán.");
  res.redirect(`/teams/${req.params.id}`);
});
teamsRouter.post("/teams/:id/members/:pid/role", async (req, res) => {
  const role = ROLES.has(req.body.role) ? req.body.role : "editor";
  await setTeamMemberRole(req.params.id, req.params.pid, role);
  await audit({ source: "admin", actor: req.admin!.email, action: "team.set-role", target: req.params.id, detail: { profileId: req.params.pid, role } });
  setFlash(res, "ok", "Role změněna.");
  res.redirect(`/teams/${req.params.id}`);
});
teamsRouter.post("/teams/:id/members/:pid/remove", async (req, res) => {
  await removeTeamMember(req.params.id, req.params.pid);
  await audit({ source: "admin", actor: req.admin!.email, action: "team.remove-member", target: req.params.id, detail: { profileId: req.params.pid } });
  setFlash(res, "ok", "Člen odebrán.");
  res.redirect(`/teams/${req.params.id}`);
});
