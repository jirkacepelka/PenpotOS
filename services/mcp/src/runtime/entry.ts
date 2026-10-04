/**
 * Browser-side runtime injected into the headless Penpot workspace.
 *
 * It exposes the Penpot Plugin API (the `ɵcontext` object created by Penpot's
 * plugin runtime) under the same names the official Penpot MCP plugin uses:
 * `penpot`, `penpotUtils` and `storage`, so instructions and code written for
 * the official MCP server work unchanged.
 */
import { PenpotUtils } from "../../../../vendor/penpot-mcp/plugin/PenpotUtils.ts";
import { formatTaskError } from "../../../../vendor/penpot-mcp/plugin/ErrorUtils.ts";

declare const ɵcontext: any;

class CapturingConsole {
  private out = "";
  reset() {
    this.out = "";
  }
  get() {
    return this.out;
  }
  private add(level: string, args: any[]) {
    const msg = args
      .map((a) => {
        if (typeof a !== "object" || a === null) return String(a);
        try {
          return JSON.stringify(a, null, 2);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    this.out += `[${level}] ${msg}\n`;
  }
  log(...a: any[]) { this.add("LOG", a); }
  info(...a: any[]) { this.add("INFO", a); }
  warn(...a: any[]) { this.add("WARN", a); }
  error(...a: any[]) { this.add("ERROR", a); }
  debug(...a: any[]) { this.add("DEBUG", a); }
  trace(...a: any[]) { this.add("TRACE", a); }
  table(d: any) { this.add("TABLE", [d]); }
  time(l?: string) { this.add("TIME", [`Timer started: ${l ?? "default"}`]); }
  timeEnd(l?: string) { this.add("TIME_END", [`Timer ended: ${l ?? "default"}`]); }
  group(l?: string) { this.add("GROUP", [l ?? ""]); }
  groupCollapsed(l?: string) { this.add("GROUP_COLLAPSED", [l ?? ""]); }
  groupEnd() { this.add("GROUP_END", [""]); }
  count(l?: string) { this.add("COUNT", [l ?? "default"]); }
  countReset(l?: string) { this.add("COUNT_RESET", [l ?? "default"]); }
  assert(c: boolean, ...a: any[]) { if (!c) this.add("ASSERT", a); }
  clear() {}
}

/** Plugin-API facade: the raw context plus the helpers the plugin runtime normally adds. */
function createPenpotFacade(ctx: any) {
  const utils = {
    geometry: {
      center(shapes: any[]) {
        return (window as any).app?.plugins?.public_utils?.centerShapes(shapes);
      },
    },
    types: {
      isBoard: (s: any) => s?.type === "board",
      isGroup: (s: any) => s?.type === "group",
      isMask: (s: any) => s?.type === "group" && s.isMask(),
      isBool: (s: any) => s?.type === "boolean",
      isRectangle: (s: any) => s?.type === "rectangle",
      isPath: (s: any) => s?.type === "path",
      isText: (s: any) => s?.type === "text",
      isEllipse: (s: any) => s?.type === "ellipse",
      isSVG: (s: any) => s?.type === "svg-raw",
      isVariantContainer: (s: any) => s?.type === "board" && s.isVariantContainer(),
      isVariantComponent: (c: any) => c?.isVariant(),
    },
  };
  const ui = {
    open() {
      throw new Error("penpot.ui is not available in the headless PenpotOS runtime");
    },
    sendMessage() {},
    onMessage() {},
    resize() {},
    get size() {
      return null;
    },
  };
  const extra: Record<string, unknown> = {
    utils,
    ui,
    closePlugin() {},
    on(type: string, callback: (e: unknown) => void, props?: Record<string, unknown>) {
      return ctx.addListener(type, callback, props);
    },
    off(id: unknown) {
      return ctx.removeListener(id);
    },
  };
  return new Proxy(ctx, {
    get(target, prop, _receiver) {
      if (typeof prop === "string" && prop in extra) return extra[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

const penpot = createPenpotFacade(ɵcontext);
(globalThis as any).penpot = penpot; // PenpotUtils refers to the global `penpot`
const storages = new Map<string, Record<string, unknown>>();
const capture = new CapturingConsole();

export interface ExecResult {
  ok: boolean;
  /** JSON-serialised result (or error message when !ok). */
  json?: string;
  error?: string;
  log: string;
}

async function exec(code: string, opts: { storageKey?: string; pageId?: string } = {}): Promise<ExecResult> {
  capture.reset();
  const key = opts.storageKey ?? "default";
  if (!storages.has(key)) storages.set(key, {});
  const context: Record<string, unknown> = {
    penpot,
    storage: storages.get(key),
    console: capture,
    penpotUtils: PenpotUtils,
  };
  const flags = ɵcontext.flags;
  const prevOrdering = flags?.naturalChildOrdering;
  const prevThrow = flags?.throwValidationErrors;
  try {
    if (opts.pageId && penpot.currentPage?.id !== opts.pageId) {
      await penpot.openPage(opts.pageId);
    }
    if (flags) {
      flags.naturalChildOrdering = true;
      flags.throwValidationErrors = true;
    }
    const fn = new Function(...Object.keys(context), `return (async () => { ${code} })();`);
    let result = await fn(...Object.values(context));
    if (result instanceof Uint8Array) result = { __type: "base64", data: bytesToBase64(result) };
    let json: string | undefined;
    try {
      json = result === undefined ? undefined : JSON.stringify(result);
    } catch (err) {
      return { ok: false, error: `Result is not serialisable: ${formatTaskError(err)}`, log: capture.get() };
    }
    return { ok: true, json, log: capture.get() };
  } catch (err) {
    return { ok: false, error: formatTaskError(err), log: capture.get() };
  } finally {
    if (flags) {
      flags.naturalChildOrdering = prevOrdering;
      flags.throwValidationErrors = prevThrow;
    }
  }
}

/**
 * Persistence status of the open file ("pending" | "saving" | "saved" | "error"),
 * read through Penpot's exported debug helper; null when nothing was changed yet,
 * "unknown" when the helper is not available.
 */
function persistenceStatus(): string | null {
  const dbg = (globalThis as any).debug;
  if (typeof dbg?.get_state !== "function") return "unknown";
  const original = console.log;
  let captured: unknown = null;
  console.log = (value: unknown) => {
    captured = value;
  };
  try {
    dbg.get_state(":persistence :status");
  } catch {
    return "unknown";
  } finally {
    console.log = original;
  }
  return captured === null || captured === undefined ? null : String(captured);
}

(globalThis as any).__penpotos = {
  version: 1,
  exec,
  persistenceStatus,
  fileId: () => ɵcontext.currentFile?.id ?? null,
};
