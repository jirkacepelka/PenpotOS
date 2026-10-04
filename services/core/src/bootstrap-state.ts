/**
 * Startup state of the core service. The gateway and the admin dashboard listen
 * from the first second and use this to show a readable diagnostic page instead
 * of the connection simply being refused while something is misconfigured.
 */

export interface StartupProblem {
  title: string;
  hint: string;
  detail: string;
}

export interface BootstrapState {
  status: "starting" | "error" | "ready";
  problem?: StartupProblem;
  attempts: number;
  since: Date;
}

const state: BootstrapState = { status: "starting", attempts: 0, since: new Date() };

export function bootstrapState(): Readonly<BootstrapState> {
  return state;
}

export function markAttempt() {
  state.attempts++;
}

export function markReady() {
  state.status = "ready";
  state.problem = undefined;
}

export function markError(err: unknown) {
  state.status = "error";
  state.problem = describeStartupError(err);
}

/** Error raised for configuration mistakes that retrying cannot fix. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Maps low-level startup errors to an explanation an administrator can act on. */
export function describeStartupError(err: unknown): StartupProblem {
  const e = err as { message?: string; code?: string; hint?: string; cause?: { code?: string } };
  const detail = String(e?.message ?? err);
  const code = e?.code ?? e?.cause?.code;

  if (err instanceof ConfigError) {
    return { title: err.message, hint: err.hint, detail };
  }
  if (code === "28P01" || /password authentication failed/i.test(detail)) {
    return {
      title: "Heslo databáze nesedí s existující databází",
      hint:
        "Databázový volume vznikl při dřívější instalaci s jiným heslem (PostgreSQL ho přebírá jen při prvním vytvoření). " +
        "Aplikaci odinstaluj, smaž její volumy (docker volume ls | grep penpotos) a nainstaluj znovu.",
      detail,
    };
  }
  if (code === "42P01" || /relation "profile" does not exist/i.test(detail)) {
    return {
      title: "Penpot ještě zakládá databázi",
      hint: "Při prvním spuštění to trvá 1–3 minuty. Stránka se sama obnoví.",
      detail,
    };
  }
  if (/PREPL/i.test(detail)) {
    return {
      title: "Správa účtů Penpotu (PREPL) zatím není dostupná",
      hint:
        "Backend Penpotu ještě startuje (první start trvá 1–3 minuty). Pokud to trvá déle, zkontroluj, že kontejner penpot-backend běží a má ve PENPOT_FLAGS hodnotu enable-prepl-server a PENPOT_PREPL_HOST=0.0.0.0.",
      detail,
    };
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || /ECONNREFUSED|ENOTFOUND|getaddrinfo/.test(detail)) {
    return {
      title: "Nedaří se spojit s databází nebo Penpotem",
      hint: "Kontejnery penpot-postgres / penpot-backend možná ještě startují, nebo neběží. Zkontroluj jejich stav a logy v ZimaOS.",
      detail,
    };
  }
  return { title: "PenpotOS se nepodařilo spustit", hint: "Podrobnosti najdeš v logu kontejneru penpotos-core.", detail };
}

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Self-contained status page (inline CSS, refreshes itself). */
export function renderStatusPage(): string {
  const s = state;
  const starting = s.status !== "error";
  const title = starting ? "PenpotOS se spouští…" : "PenpotOS se nespustil";
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--panel:#fff;--text:#1a1a1a;--muted:#6b6b6b;--line:#e3e3df;--accent:#ffd200;--err:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--panel:#1e1e1e;--text:#eee;--muted:#a0a0a0;--line:#333}}
body{margin:0;font:15px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--text)}
.box{max-width:640px;margin:10vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px 28px}
h1{font-size:22px;margin:0 0 12px}.logo{color:var(--accent)}h2{font-size:17px;margin:18px 0 6px;color:${starting ? "var(--text)" : "var(--err)"}}
p{margin:6px 0}.muted{color:var(--muted);font-size:13px}code,pre{font-family:ui-monospace,monospace;font-size:12px;background:var(--bg);border-radius:6px}
pre{padding:10px;white-space:pre-wrap;word-break:break-word}
</style></head><body><div class="box">
<h1><span class="logo">◆</span> ${title}</h1>
${
  s.problem
    ? `<h2>${esc(s.problem.title)}</h2><p>${esc(s.problem.hint)}</p><details><summary class="muted">Technické podrobnosti</summary><pre>${esc(s.problem.detail)}</pre></details>`
    : `<p>Penpot a databáze startují (první start trvá 1–3 minuty).</p>`
}
<p class="muted">Pokus č. ${s.attempts} · běží od ${esc(s.since.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" }))} · stránka se obnovuje každých 10 s.</p>
</div></body></html>`;
}
