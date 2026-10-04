import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { botRpc, createLogger, env, fileTeamId, getSettings } from "@penpotos/shared";
import { runtimeScript } from "./runtime-bundle.ts";

const log = createLogger("browser");

const UPDATE_FILE_RE = /\/api\/(?:rpc\/command|main\/methods)\/update-file/;

export class AccessDeniedError extends Error {}
export class ReadOnlyViolationError extends Error {}

export interface ExecOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  log: string;
  /** Set when the AI tried to modify a design while write access is disabled. */
  writeBlocked?: boolean;
}

/** One headless workspace tab with a file open. */
class FileSession {
  inflightSaves = 0;
  lastSaveActivity = 0;
  writeBlocked = false;
  lastUsed = Date.now();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly key: string,
    readonly fileId: string,
    readonly teamId: string,
    readonly page: Page,
    readonly readOnly: boolean,
  ) {}

  /** Serialises work on this tab (the Plugin API is not re-entrant). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    this.lastUsed = Date.now();
    return next;
  }

  /**
   * Waits until Penpot has persisted all pending changes. Uses Penpot's own persistence
   * status (pending → saving → saved); falls back to watching update-file requests.
   * Returns the final status ("saved", "error", "timeout").
   */
  async waitForSaves(maxMs = 60_000): Promise<string> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() - start < maxMs) {
      let status: string | null = "unknown";
      try {
        status = await this.page.evaluate(() => (globalThis as any).__penpotos?.persistenceStatus?.() ?? "unknown");
      } catch {
        return "error";
      }
      if (status === "unknown") {
        // Fallback: Penpot sends changes ~3 s after the last edit.
        const quietFor = Date.now() - Math.max(this.lastSaveActivity, start);
        if (this.inflightSaves === 0 && quietFor > 4000) return "saved";
      } else if (status === "error") {
        return "error";
      } else if ((status === null || status === "saved") && this.inflightSaves === 0) {
        return "saved";
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    log.warn(`file ${this.fileId}: saves still pending after ${maxMs} ms`);
    return "timeout";
  }
}

export class BrowserPool {
  private browser?: Browser;
  private context?: BrowserContext;
  private starting?: Promise<BrowserContext>;
  private sessions = new Map<string, FileSession>();
  private opening = new Map<string, Promise<FileSession>>();
  private lastWriteEnabled?: boolean;

  constructor() {
    setInterval(() => this.reapIdle().catch(() => {}), 60_000).unref();
  }

  status() {
    return {
      connected: !!this.browser?.isConnected(),
      openFiles: this.sessions.size,
      files: [...this.sessions.values()].map((s) => ({ fileId: s.fileId, idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000) })),
    };
  }

  private sessionForFile(fileId: string | null): FileSession | undefined {
    if (!fileId) return undefined;
    for (const s of this.sessions.values()) if (s.fileId === fileId) return s;
    for (const s of this.pendingSessions) if (s.fileId === fileId) return s;
    return undefined;
  }

  /** Sessions whose tab is still loading (not yet in `sessions`). */
  private pendingSessions = new Set<FileSession>();

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.browser?.isConnected()) return this.context;
    if (!this.starting) {
      this.starting = (async () => {
        await this.shutdown();
        log.info("launching headless Chromium");
        this.browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        });
        this.browser.on("disconnected", () => {
          log.warn("Chromium disconnected");
          this.sessions.clear();
          this.context = undefined;
        });
        const context = await this.browser.newContext({
          bypassCSP: true,
          viewport: { width: 1600, height: 1000 },
          locale: "cs-CZ",
          timezoneId: "Europe/Prague",
        });
        // Penpot's config.js pins the API base to the public URL; the headless browser talks to
        // the internal frontend directly, so point the app at the internal origin instead.
        await context.route(/\/js\/config\.js(\?|$)/, async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(/^\s*var penpotPublicURI\s*=.*$/gm, "") + `\nvar penpotPublicURI = ${JSON.stringify(env.penpotInternalUrl)};\n`;
          await route.fulfill({ response, body });
        });
        // Some URLs (e.g. exported assets returned by the exporter) still use the public URL;
        // serve them from the internal frontend so the headless browser never leaves the server.
        const publicOrigin = new URL(env.publicUrl).origin;
        const internalOrigin = new URL(env.penpotInternalUrl).origin;
        if (publicOrigin !== internalOrigin) {
          await context.route(
            (url) => url.origin === publicOrigin,
            async (route) => {
              const u = new URL(route.request().url());
              const response = await route.fetch({ url: internalOrigin + u.pathname + u.search });
              await route.fulfill({
                response,
                headers: { ...response.headers(), "access-control-allow-origin": internalOrigin, "access-control-allow-credentials": "true" },
              });
            },
          );
        }
        // Track Penpot's persistence requests (they are sent from a web worker, so this has to
        // happen at context level) and block them for read-only tabs.
        const saveTarget = (u: string) => (UPDATE_FILE_RE.test(u) ? this.sessionForFile(new URL(u).searchParams.get("id")) : undefined);
        context.on("request", (req) => {
          const s = saveTarget(req.url());
          if (!s) return;
          log.debug(`[${s.fileId}] save request`);
          s.inflightSaves++;
          s.lastSaveActivity = Date.now();
        });
        const settled = (req: { url(): string }) => {
          const s = saveTarget(req.url());
          if (!s) return;
          s.inflightSaves = Math.max(0, s.inflightSaves - 1);
          s.lastSaveActivity = Date.now();
        };
        context.on("requestfinished", settled);
        context.on("requestfailed", settled);
        await context.route(UPDATE_FILE_RE, (route) => {
          const s = saveTarget(route.request().url());
          if (s?.readOnly) {
            s.writeBlocked = true;
            return route.abort("blockedbyclient");
          }
          return route.fallback();
        });
        await this.loginContext(context);
        this.context = context;
        return context;
      })().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  /** Logs the AI service account in and puts its session cookies into the browser. */
  private async loginContext(context: BrowserContext, force = false) {
    const rpc = await botRpc(force);
    const url = new URL(env.penpotInternalUrl);
    await context.clearCookies();
    await context.addCookies(
      rpc.currentSession!.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      })),
    );
  }

  /** Checks admin settings (enabled, team allow-list) for a file. */
  async checkAccess(fileId: string) {
    const settings = await getSettings(true);
    if (!settings.ai.mcpEnabled) throw new AccessDeniedError("AI integrace je v admin dashboardu vypnutá.");
    const info = await fileTeamId(fileId);
    if (!info) throw new AccessDeniedError(`Soubor ${fileId} neexistuje (nebo je smazaný).`);
    if (settings.ai.allowedTeamIds && !settings.ai.allowedTeamIds.includes(info.teamId)) {
      throw new AccessDeniedError("AI nemá přístup k týmu, do kterého soubor patří (omezeno v admin dashboardu).");
    }
    return { ...info, settings };
  }

  /**
   * Returns the open tab for a file, opening it when needed.
   * `admin` sessions (used for brand-library maintenance requested by the admin
   * dashboard) bypass the AI policy and always have write access.
   */
  async session(fileId: string, opts: { admin?: boolean } = {}): Promise<FileSession> {
    let teamId: string;
    let settings: Awaited<ReturnType<typeof getSettings>>;
    if (opts.admin) {
      const info = await fileTeamId(fileId);
      if (!info) throw new Error(`Soubor ${fileId} neexistuje`);
      teamId = info.teamId;
      settings = await getSettings();
    } else {
      ({ teamId, settings } = await this.checkAccess(fileId));
    }
    const key = opts.admin ? `admin:${fileId}` : fileId;
    // A change of the write permission invalidates all tabs (read-only tabs block saving at network level).
    if (this.lastWriteEnabled !== undefined && this.lastWriteEnabled !== settings.ai.writeEnabled) {
      log.info("write permission changed – closing all open files");
      await this.closeAll();
    }
    this.lastWriteEnabled = settings.ai.writeEnabled;

    const existing = this.sessions.get(key);
    if (existing && !existing.page.isClosed()) return existing;
    let pending = this.opening.get(key);
    if (!pending) {
      const readOnly = !opts.admin && !settings.ai.writeEnabled;
      pending = this.open(key, fileId, teamId, readOnly, settings.ai.maxOpenFiles).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async open(key: string, fileId: string, teamId: string, readOnly: boolean, maxOpen: number, retried = false): Promise<FileSession> {
    const context = await this.ensureContext();
    await this.evict(maxOpen - 1);
    // Never keep the same file open twice (e.g. admin + AI tab) – concurrent edits would conflict.
    for (const other of [...this.sessions.values()]) if (other.fileId === fileId && other.key !== key) await this.close(other);
    const page = await context.newPage();
    const session = new FileSession(key, fileId, teamId, page, readOnly);
    this.pendingSessions.add(session);
    page.on("pageerror", (err) => log.debug(`[${fileId}] page error: ${err.message}`));
    page.on("close", () => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });

    const qs = new URLSearchParams({ "team-id": teamId, "file-id": fileId });
    const url = `${env.penpotInternalUrl}/#/workspace?${qs}`;
    log.info(`opening file ${fileId}${readOnly ? " (read-only)" : ""}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForFunction(
        (id) => {
          const ctx = (globalThis as any).ɵcontext;
          if (location.hash.includes("/auth/login")) return "login";
          try {
            return ctx?.currentFile?.id === id && ctx?.currentPage ? "ready" : false;
          } catch {
            return false;
          }
        },
        fileId,
        { timeout: 120_000, polling: 250 },
      );
      if (page.url().includes("/auth/login")) throw new Error("login-required");
      await page.addScriptTag({ content: await runtimeScript() });
      await page.waitForFunction(() => !!(globalThis as any).__penpotos, null, { timeout: 10_000 });
    } catch (err: any) {
      this.pendingSessions.delete(session);
      await page.close().catch(() => {});
      if (!retried && (err.message === "login-required" || page.url().includes("/auth/login"))) {
        log.warn("browser session expired – logging in again");
        await this.loginContext(context, true);
        return this.open(key, fileId, teamId, readOnly, maxOpen, true);
      }
      throw new Error(`Nepodařilo se otevřít soubor ${fileId} v headless Penpotu: ${err.message}`);
    }
    this.pendingSessions.delete(session);
    this.sessions.set(key, session);
    return session;
  }

  /** Executes Plugin-API code in the given file and waits until changes are persisted. */
  async exec(
    fileId: string,
    code: string,
    opts: { storageKey?: string; pageId?: string; timeoutMs?: number; admin?: boolean } = {},
  ): Promise<ExecOutcome> {
    const session = await this.session(fileId, { admin: opts.admin });
    return session.run(async () => {
      session.writeBlocked = false;
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const evaluation = session.page.evaluate(
        ({ code, storageKey, pageId }) => (globalThis as any).__penpotos.exec(code, { storageKey, pageId }),
        { code, storageKey: opts.storageKey, pageId: opts.pageId },
      ) as Promise<{ ok: boolean; json?: string; error?: string; log: string }>;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`Časový limit ${Math.round(timeoutMs / 1000)} s vypršel`)), timeoutMs);
      });
      let raw;
      try {
        raw = await Promise.race([evaluation, timeout]);
      } catch (err: any) {
        // A hung evaluation leaves the tab in an unknown state – discard it.
        await session.page.close().catch(() => {});
        throw err;
      } finally {
        clearTimeout(timer);
      }
      // Read-only tabs also wait: the (blocked) save attempt tells us that the code tried to modify the file.
      const saveStatus = await session.waitForSaves(session.readOnly ? 15_000 : 60_000);

      const outcome: ExecOutcome = { ok: raw.ok, log: raw.log, error: raw.error };
      if (!session.readOnly && saveStatus !== "saved") {
        outcome.log += `[PENPOTOS] Warning: changes may not have been saved (persistence status: ${saveStatus}).\n`;
      }
      if (raw.ok && raw.json !== undefined) outcome.result = JSON.parse(raw.json);
      if (session.readOnly && session.writeBlocked) {
        // Local edits were never saved; reload the tab so it matches the server state again.
        outcome.writeBlocked = true;
        await session.page.close().catch(() => {});
      }
      return outcome;
    });
  }

  private async evict(keep: number) {
    const sorted = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    while (sorted.length > Math.max(0, keep)) {
      const s = sorted.shift()!;
      await this.close(s);
    }
  }

  private async close(s: FileSession) {
    if (this.sessions.get(s.key) === s) this.sessions.delete(s.key);
    await s.run(async () => {
      if (!s.readOnly) await s.waitForSaves(30_000);
      await s.page.close({ runBeforeUnload: false }).catch(() => {});
    });
  }

  async closeFile(fileId: string) {
    for (const s of [...this.sessions.values()]) if (s.fileId === fileId) await this.close(s);
  }

  async closeAll() {
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }

  private async reapIdle() {
    const idleMs = env.int("PENPOTOS_MCP_IDLE_CLOSE_SECONDS", 900) * 1000;
    for (const s of [...this.sessions.values()]) {
      if (Date.now() - s.lastUsed > idleMs) {
        log.info(`closing idle file ${s.fileId}`);
        await this.close(s);
      }
    }
  }

  async shutdown() {
    await this.closeAll().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.context = undefined;
  }
}

export const browserPool = new BrowserPool();
