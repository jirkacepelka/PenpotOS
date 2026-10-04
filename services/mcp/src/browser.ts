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

/** Clipboard API for the (insecure) internal origin; text types as strings, binary types as base64. */
const CLIPBOARD_POLYFILL = `(() => {
  if (navigator.clipboard) return;
  const bridge = (op, data) => window.__ppClipboard(op, data);
  const isText = (t) => t.startsWith("text/") || t.includes("json") || t.includes("penpot");
  const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s, type) => { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new Blob([b], { type }); };
  class ClipboardItemPolyfill {
    constructor(items) { this._items = items; this.types = Object.keys(items); }
    async getType(t) { const v = await this._items[t]; return v instanceof Blob ? v : new Blob([v], { type: t }); }
  }
  if (!window.ClipboardItem) window.ClipboardItem = ClipboardItemPolyfill;
  const clipboard = {
    async writeText(text) { await bridge("set", { "text/plain": String(text) }); },
    async readText() { return (await bridge("get"))["text/plain"] ?? ""; },
    async write(items) {
      const data = {};
      for (const item of items) for (const t of item.types) {
        const blob = await item.getType(t);
        data[t] = isText(t) ? await blob.text() : "b64:" + (await toB64(blob));
      }
      await bridge("set", data);
    },
    async read() {
      const data = await bridge("get");
      const items = {};
      for (const [t, v] of Object.entries(data)) items[t] = v.startsWith("b64:") && !isText(t) ? fromB64(v.slice(4), t) : new Blob([v], { type: t });
      return Object.keys(items).length ? [new ClipboardItemPolyfill(items)] : [];
    },
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
})();`;

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
          args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
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
        // The internal http origin is not a secure context, so the browser offers no Clipboard API.
        // Penpot needs one for copy & paste (copy_shapes): provide a clipboard shared by all tabs.
        await context.exposeBinding("__ppClipboard", (_src, op: "set" | "get", data?: Record<string, string>) => {
          if (op === "set") this.clipboardData = data ?? {};
          return this.clipboardData;
        });
        await context.addInitScript(CLIPBOARD_POLYFILL);
        // Penpot's config.js pins the API base to the public URL; the headless browser talks to
        // the internal frontend directly, so point the app at the internal origin instead.
        await context.route(/\/js\/config\.js(\?|$)/, async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(/^\s*var penpotPublicURI\s*=.*$/gm, "") + `\nvar penpotPublicURI = ${JSON.stringify(env.penpotInternalUrl)};\n`;
          await route.fulfill({ response, body });
        });
        // Asset URLs (e.g. finished exports) are built from Penpot's configured public address,
        // which may not be reachable from inside the server – serve them from the internal frontend.
        const internalOrigin = new URL(env.penpotInternalUrl).origin;
        await context.route(
          (url) => url.origin !== internalOrigin && url.pathname.startsWith("/assets/"),
          async (route) => {
            const u = new URL(route.request().url());
            const response = await route.fetch({ url: internalOrigin + u.pathname + u.search });
            await route.fulfill({
              response,
              headers: { ...response.headers(), "access-control-allow-origin": internalOrigin, "access-control-allow-credentials": "true" },
            });
          },
        );
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

  /**
   * Copies shapes to another page or file the way a person would: select, Ctrl+C, switch, Ctrl+V.
   * The Plugin API can only modify the active page and cannot reach other files, while Penpot's
   * own clipboard keeps everything (texts, images, components, layout).
   */
  async copyShapes(opts: {
    fileId: string;
    shapeIds: string[];
    pageId?: string;
    targetFileId?: string;
    targetPageId?: string;
    storageKey?: string;
  }): Promise<{ ok: boolean; error?: string; pasted?: { id: string; name: string; x: number; y: number; width: number; height: number }[] }> {
    const targetFileId = opts.targetFileId ?? opts.fileId;
    // One clipboard per browser: copy operations of different users must not interleave.
    const release = await this.lockClipboard();
    try {
      const select = `const ids = ${JSON.stringify(opts.shapeIds)};
        // Switch to the page that holds the shapes (the tab may still show another page).
        const home = penpot.currentFile.pages.find((p) => p.getShapeById?.(ids[0]));
        if (home && home.id !== penpot.currentPage.id) {
          penpot.openPage(home);
          for (let i = 0; i < 40 && penpot.currentPage.id !== home.id; i++) await new Promise((r) => setTimeout(r, 100));
        }
        const shapes = ids.map((id) => penpot.currentPage.getShapeById?.(id) ?? penpotUtils.findShapeById(id)).filter(Boolean);
        if (shapes.length !== ids.length) throw new Error("Shape not found on this page: " + ids.filter((id) => !penpotUtils.findShapeById(id)).join(", "));
        penpot.selection = shapes;
        return shapes.length;`;
      const src = await this.session(opts.fileId);
      // Keyboard shortcuts only reach Penpot once the canvas has focus.
      await src.run(() => this.focusCanvas(src));
      const selected = await this.exec(opts.fileId, select, { storageKey: opts.storageKey, pageId: opts.pageId });
      if (!selected.ok) return { ok: false, error: selected.error };
      const copied = await src.run(async () => {
        this.clipboardData = {};
        await src.page.keyboard.press("ControlOrMeta+c");
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 150));
          if (Object.keys(this.clipboardData).length) return true;
        }
        return false;
      });
      if (!copied) {
        const diag = await src.page
          .evaluate(() => `secure=${isSecureContext} clipboard=${typeof navigator.clipboard} focus=${document.activeElement?.tagName}.${(document.activeElement as HTMLElement)?.className ?? ""}`)
          .catch((e) => String(e));
        return { ok: false, error: `Copy failed (Penpot did not write to the clipboard; ${diag})` };
      }

      const dst = await this.session(targetFileId);
      const prepared = await this.exec(targetFileId, "return penpot.currentPage.id;", { storageKey: opts.storageKey, pageId: opts.targetPageId });
      if (!prepared.ok) return { ok: false, error: prepared.error };
      await dst.run(() => this.focusCanvas(dst));
      const cleared = await this.exec(targetFileId, "penpot.selection = []; return true;", { storageKey: opts.storageKey, pageId: opts.targetPageId });
      if (!cleared.ok) return { ok: false, error: cleared.error };
      const types = Object.keys(this.clipboardData);
      await dst.run(async () => {
        // Penpot pastes from the DOM paste event; headless Chromium would fire it with the (empty)
        // system clipboard, so dispatch it with the copied data instead.
        await dst.page.evaluate((data) => {
          const dt = new DataTransfer();
          for (const [t, v] of Object.entries(data)) if (!v.startsWith("b64:")) dt.setData(t, v);
          const target = document.activeElement ?? document.body;
          target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        }, this.clipboardData);
      });
      log.debug(`paste of ${types.join(", ")} into ${targetFileId}`);
      const read = `for (let i = 0; i < 40 && penpot.selection.length === 0; i++) await new Promise((r) => setTimeout(r, 150));
        return penpot.selection.map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y, width: s.width, height: s.height }));`;
      const result = await this.exec(targetFileId, read, { storageKey: opts.storageKey, pageId: opts.targetPageId });
      if (!result.ok) return { ok: false, error: result.error };
      const pasted = result.result as any[];
      if (!pasted?.length) return { ok: false, error: "Paste failed (nothing was inserted)" };
      return { ok: true, pasted };
    } finally {
      release();
    }
  }

  private clipboardData: Record<string, string> = {};
  private clipboardQueue: Promise<void> = Promise.resolve();
  private async lockClipboard(): Promise<() => void> {
    let release!: () => void;
    const prev = this.clipboardQueue;
    this.clipboardQueue = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  }

  /** Gives the workspace keyboard focus with a click on an empty spot of the canvas. */
  private async focusCanvas(session: FileSession) {
    await session.page.bringToFront();
    const vp = session.page.viewportSize() ?? { width: 1600, height: 1000 };
    await session.page.mouse.click(Math.round(vp.width * 0.55), vp.height - 60);
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
