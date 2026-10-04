import {
  INTERNAL_HEADER,
  addTeamMember,
  audit,
  botCall,
  createLogger,
  env,
  getSettings,
  getState,
  listProfiles,
  listTeams,
  markOnboarded,
  setState,
  sha256,
  type Settings,
  type TeamRow,
} from "@penpotos/shared";

const log = createLogger("sync");

export interface SyncReport {
  at: string;
  teams: number;
  membershipsAdded: number;
  projectsCreated: number;
  librariesUpdated: number;
  errors: string[];
}

let running: Promise<SyncReport> | undefined;
let lastReport: SyncReport | undefined;

export function getLastSyncReport() {
  return lastReport;
}

/** Runs a full synchronisation (deduplicated when already running). */
export function runSync(reason = "interval"): Promise<SyncReport> {
  if (!running) {
    running = doSync(reason).finally(() => {
      running = undefined;
    });
  }
  return running;
}

function eligibleTeams(teams: TeamRow[], settings: Settings): TeamRow[] {
  return teams.filter(
    (t) => !settings.membership.excludedTeamIds.includes(t.id) && !(settings.membership.skipPersonalTeams && t.isDefault),
  );
}

async function doSync(reason: string): Promise<SyncReport> {
  const settings = await getSettings(true);
  const report: SyncReport = {
    at: new Date().toISOString(),
    teams: 0,
    membershipsAdded: 0,
    projectsCreated: 0,
    librariesUpdated: 0,
    errors: [],
  };
  const teams = eligibleTeams(await listTeams(), settings);
  report.teams = teams.length;
  const profiles = (await listProfiles()).filter((p) => p.managed && !p.isBlocked);
  const bot = profiles.find((p) => p.isService);

  // 1) Memberships: the AI account always joins every team so the AI has global access;
  //    members join every team when auto-join is enabled.
  for (const team of teams) {
    for (const p of profiles) {
      if (!p.isService && !settings.membership.autoJoinAllTeams) continue;
      const role = p.isService ? "editor" : p.role === "admin" ? "admin" : settings.membership.defaultTeamRole;
      try {
        if (await addTeamMember(team.id, p.id, role)) {
          report.membershipsAdded++;
          log.info(`added ${p.email} to team "${team.name}" as ${role}`);
        }
      } catch (err: any) {
        report.errors.push(`${p.email} → ${team.name}: ${err.message}`);
      }
    }
  }
  for (const p of profiles) if (!p.isService) await markOnboarded(p.id).catch(() => {});

  // 2) Team defaults (projects + brand library) are created as the AI account.
  if (bot) {
    for (const team of teams) {
      try {
        report.projectsCreated += await ensureDefaultProjects(team, settings);
        if (settings.onboarding.libraryEnabled && (await ensureBrandLibrary(team, settings))) report.librariesUpdated++;
      } catch (err: any) {
        report.errors.push(`Tým ${team.name}: ${err.message}`);
        log.warn(`team defaults for "${team.name}" failed`, err.message);
      }
    }
  }

  if (report.membershipsAdded || report.projectsCreated || report.librariesUpdated || report.errors.length) {
    await audit({ source: "system", action: "sync", detail: { reason, ...report }, ok: report.errors.length === 0 });
  }
  lastReport = report;
  return report;
}

async function getProjects(teamId: string): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  return botCall("get-projects", { teamId });
}

async function ensureProject(teamId: string, name: string): Promise<{ id: string; created: boolean }> {
  const projects = await getProjects(teamId);
  const found = projects.find((p) => p.name === name);
  if (found) return { id: found.id, created: false };
  const created = await botCall<{ id: string }>("create-project", { teamId, name });
  return { id: created.id, created: true };
}

async function ensureDefaultProjects(team: TeamRow, settings: Settings): Promise<number> {
  let created = 0;
  for (const name of settings.onboarding.defaultProjects) {
    if (!name.trim()) continue;
    if ((await ensureProject(team.id, name.trim())).created) created++;
  }
  return created;
}

interface LibraryState {
  [teamId: string]: { fileId: string; hash: string };
}

/**
 * Ensures the shared brand library exists in the team and contains the configured
 * palette/typographies. Content is written through the MCP service (Penpot Plugin API).
 */
async function ensureBrandLibrary(team: TeamRow, settings: Settings): Promise<boolean> {
  const { libraryName, libraryProjectName, palette, typographies } = settings.onboarding;
  const hash = sha256(JSON.stringify({ libraryName, palette, typographies }));
  const state = (await getState<LibraryState>("brand-libraries")) ?? {};
  const known = state[team.id];

  const project = await ensureProject(team.id, libraryProjectName);
  const files: { id: string; name: string; isShared: boolean }[] = await botCall("get-project-files", { projectId: project.id });
  let file = (known && files.find((f) => f.id === known.fileId)) || files.find((f) => f.name === libraryName);
  if (!file) {
    const created = await botCall<{ id: string; name: string }>("create-file", { projectId: project.id, name: libraryName });
    file = { id: created.id, name: created.name, isShared: false };
    log.info(`created brand library in team "${team.name}"`);
  } else if (file.name !== libraryName) {
    await botCall("rename-file", { id: file.id, name: libraryName });
  }
  if (!file.isShared) await botCall("set-file-shared", { id: file.id, isShared: true });
  if (known?.fileId === file.id && known.hash === hash) return false;

  const res = await fetch(`${env.mcpInternalUrl}/internal/brand-library`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [INTERNAL_HEADER]: env.internalToken },
    body: JSON.stringify({ fileId: file.id, palette, typographies }),
  });
  if (!res.ok) throw new Error(`MCP brand-library: ${res.status} ${await res.text()}`);
  state[team.id] = { fileId: file.id, hash };
  await setState("brand-libraries", state);
  return true;
}

/** Forces brand libraries to be rewritten on the next sync. */
export async function invalidateBrandLibraries() {
  const state = (await getState<LibraryState>("brand-libraries")) ?? {};
  for (const k of Object.keys(state)) state[k].hash = "";
  await setState("brand-libraries", state);
}

export function startSyncLoop() {
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await runSync("interval");
    } catch (err) {
      log.error("sync failed", err);
    }
    const settings = await getSettings().catch(() => undefined);
    timer = setTimeout(tick, (settings?.membership.syncIntervalMinutes ?? 5) * 60_000);
  };
  timer = setTimeout(tick, 5_000);
  return () => timer && clearTimeout(timer);
}
