import { INTERNAL_HEADER, env, preplExec } from "@penpotos/shared";

export interface ServiceStatus {
  ok: boolean;
  detail: string;
  data?: any;
}

async function timed<T>(p: Promise<T>, ms = 4000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export async function penpotStatus(): Promise<ServiceStatus> {
  try {
    const res = await timed(fetch(`${env.penpotBackendUrl}/api/rpc/command/get-profile`, { headers: { Accept: "application/json" } }));
    return { ok: res.ok, detail: res.ok ? "Backend odpovídá" : `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: err.message };
  }
}

export async function preplStatus(): Promise<ServiceStatus> {
  try {
    await timed(preplExec("echo", { ping: true }, { timeoutMs: 4000 }));
    return { ok: true, detail: "PREPL dostupný" };
  } catch (err: any) {
    return { ok: false, detail: err.message };
  }
}

async function internalStatus(base: string): Promise<ServiceStatus> {
  try {
    const res = await timed(fetch(`${base}/internal/status`, { headers: { [INTERNAL_HEADER]: env.internalToken } }));
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok !== false, detail: data.detail ?? `HTTP ${res.status}`, data };
  } catch (err: any) {
    return { ok: false, detail: err.message };
  }
}

export const mcpStatus = () => internalStatus(env.mcpInternalUrl);
export const discordStatus = () => internalStatus(env.str("PENPOTOS_DISCORD_INTERNAL_URL", "http://penpotos-discord:4500").replace(/\/+$/, ""));

export async function allStatuses() {
  const [penpot, prepl, mcp, discord] = await Promise.all([penpotStatus(), preplStatus(), mcpStatus(), discordStatus()]);
  return { penpot, prepl, mcp, discord };
}
