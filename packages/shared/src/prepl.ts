import net from "node:net";
import { env } from "./env.ts";

export class PreplError extends Error {
  constructor(
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "PreplError";
  }
}

/**
 * Client for the Penpot backend PREPL server (flag `enable-prepl-server`).
 *
 * Protocol (see penpot backend/scripts/manage.py): one JSON object per line
 * `{"cmd": "...", "params": {...}}`, answered by JSON lines tagged "out"
 * (stdout) until a line tagged "ret" carries `val` or `err`.
 */
export async function preplExec<T = unknown>(
  cmd: string,
  params: Record<string, unknown> = {},
  opts: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<T> {
  const host = opts.host ?? env.preplHost;
  const port = opts.port ?? env.preplPort;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = "";
    let settled = false;
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      clearTimeout(timer);
      err ? reject(err) : resolve(value as T);
    };
    const timer = setTimeout(() => finish(new PreplError(`PREPL ${cmd} timed out`)), timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ cmd, params }) + "\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.tag === "ret") {
          if (msg.err) {
            const hint = typeof msg.err === "object" ? (msg.err.hint ?? msg.err.message ?? JSON.stringify(msg.err)) : String(msg.err);
            finish(new PreplError(`PREPL ${cmd}: ${hint}`, msg.err));
          } else {
            finish(null, msg.val as T);
          }
        }
      }
    });
    socket.on("error", (err) => finish(new PreplError(`PREPL connection to ${host}:${port} failed: ${err.message}`)));
    socket.on("close", () => finish(new PreplError(`PREPL ${cmd}: connection closed without result`)));
  });
}

export const prepl = {
  createProfile(p: { fullname: string; email: string; password: string; isActive?: boolean }) {
    return preplExec("create-profile", {
      fullname: p.fullname,
      email: p.email,
      password: p.password,
      "is-active": p.isActive ?? true,
    });
  },
  updateProfile(p: { email: string; fullname?: string; password?: string; isActive?: boolean }) {
    const params: Record<string, unknown> = { email: p.email };
    if (p.fullname !== undefined) params.fullname = p.fullname;
    if (p.password !== undefined) params.password = p.password;
    if (p.isActive !== undefined) params["is-active"] = p.isActive;
    return preplExec<boolean>("update-profile", params);
  },
  deleteProfile(email: string, soft = true) {
    return preplExec<boolean>("delete-profile", { email, soft });
  },
  echo(value: Record<string, unknown>) {
    return preplExec("echo", value);
  },
};
