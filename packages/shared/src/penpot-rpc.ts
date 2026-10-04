import { env } from "./env.ts";

export class PenpotRpcError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "PenpotRpcError";
  }
}

export interface PenpotSession {
  /** Raw cookies returned by login-with-password ("name=value"). */
  cookies: { name: string; value: string }[];
  profileId: string;
  createdAt: number;
}

/**
 * Minimal client for Penpot's RPC API (`/api/rpc/command/<name>`).
 *
 * Requests are sent as JSON (Penpot converts camelCase/kebab-case keys),
 * responses are requested as JSON (camelCase keys).
 */
export class PenpotRpc {
  constructor(
    private readonly baseUrl: string = env.penpotBackendUrl,
    private session?: PenpotSession,
  ) {}

  get currentSession(): PenpotSession | undefined {
    return this.session;
  }

  setSession(session: PenpotSession | undefined) {
    this.session = session;
  }

  async call<T = any>(command: string, params: Record<string, unknown> = {}, opts: { method?: "GET" | "POST" } = {}): Promise<T> {
    const method = opts.method ?? "POST";
    let url = `${this.baseUrl}/api/rpc/command/${command}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.session) headers.Cookie = this.session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    let body: string | undefined;
    if (method === "GET") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
      if ([...qs].length) url += `?${qs}`;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    }
    const res = await fetch(url, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const code = data && typeof data === "object" ? (data.code ?? data.type) : undefined;
      const hint = data && typeof data === "object" ? (data.hint ?? data.message ?? code) : text;
      throw new PenpotRpcError(`Penpot RPC ${command} failed (${res.status}): ${hint ?? res.statusText}`, res.status, code, data);
    }
    if (command === "login-with-password") {
      const cookies = parseSetCookies(res.headers);
      this.session = { cookies, profileId: data?.id, createdAt: Date.now() };
    }
    return data as T;
  }

  /** Logs in and stores the session cookies on this client. */
  async login(email: string, password: string): Promise<{ id: string; email: string; fullname: string }> {
    return this.call("login-with-password", { email, password });
  }
}

export function parseSetCookies(headers: Headers): { name: string; value: string }[] {
  const raw: string[] =
    typeof (headers as any).getSetCookie === "function" ? (headers as any).getSetCookie() : [headers.get("set-cookie") ?? ""];
  const out: { name: string; value: string }[] = [];
  for (const line of raw) {
    if (!line) continue;
    const first = line.split(";")[0];
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    out.push({ name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim() });
  }
  return out;
}

/** Builds a link to a file in the Penpot workspace. */
export function workspaceUrl(base: string, ids: { teamId: string; fileId: string; pageId?: string }): string {
  const qs = new URLSearchParams({ "team-id": ids.teamId, "file-id": ids.fileId });
  if (ids.pageId) qs.set("page-id", ids.pageId);
  return `${base}/#/workspace?${qs}`;
}
