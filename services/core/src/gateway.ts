import http from "node:http";
import type { Duplex } from "node:stream";
import { createProxyServer } from "http-proxy-3";
import { INTERNAL_HEADER, audit, createLogger, env, getSettings } from "@penpotos/shared";
import { bootstrapState, renderStatusPage } from "./bootstrap-state.ts";

const log = createLogger("gateway");

/** RPC commands nobody may call through the public entrypoint. */
const ALWAYS_BLOCKED = new Set(["prepare-register-profile", "register-profile"]);
/** RPC commands blocked when "block share links" is enabled. */
const SHARE_LINK_COMMANDS = new Set(["create-share-link"]);

/** Service-to-service headers that must never be accepted from the outside. */
const INTERNAL_HEADERS = [INTERNAL_HEADER, "x-penpotos-actor", "x-penpotos-storage"];

export function stripInternalHeaders(headers: http.IncomingHttpHeaders) {
  for (const h of INTERNAL_HEADERS) delete headers[h];
}

/** Paths served by the PenpotOS MCP service (MCP endpoint + OAuth 2.1 authorization server). */
const MCP_PATHS = [/^\/mcp(\/|$|\?)/, /^\/authorize(\/|$|\?)/, /^\/token(\/|$|\?)/, /^\/register(\/|$|\?)/, /^\/revoke(\/|$|\?)/, /^\/\.well-known\/oauth-/, /^\/penpotos-auth(\/|$|\?)/];

export function rpcCommandOf(url: string): string | undefined {
  const path = url.split("?")[0];
  const m = path.match(/^\/api\/(?:rpc\/command|main\/methods)\/([a-z0-9-]+)/i);
  return m?.[1]?.toLowerCase();
}

export async function isBlocked(url: string): Promise<string | undefined> {
  const cmd = rpcCommandOf(url);
  if (!cmd) return undefined;
  if (ALWAYS_BLOCKED.has(cmd)) return "Registrace je na tomto serveru vypnutá. Účet ti založí administrátor.";
  if (SHARE_LINK_COMMANDS.has(cmd)) {
    const settings = await getSettings();
    if (settings.general.blockShareLinks) return "Veřejné odkazy na sdílení jsou na tomto serveru vypnuté.";
  }
  return undefined;
}

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^(10|127)\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Penpot builds asset URLs (e.g. finished exports) from its configured public address.
 * When a member uses Penpot from another address (LAN IP vs. tunnel domain), the browser
 * fetches those assets cross-origin – allow that for the PenpotOS address and LAN origins.
 */
export function assetCorsOrigin(url: string, origin: string | undefined): string | undefined {
  if (!origin || !url.startsWith("/assets/")) return undefined;
  try {
    const o = new URL(origin);
    if (o.origin === new URL(env.publicUrl).origin || isPrivateHost(o.hostname)) return o.origin;
  } catch {
    return undefined;
  }
  return undefined;
}

export function isMcpPath(url: string): boolean {
  return MCP_PATHS.some((re) => re.test(url));
}

export function startGateway(port: number) {
  const penpotTarget = env.penpotInternalUrl;
  const mcpTarget = env.mcpInternalUrl;
  const proxy = createProxyServer({ xfwd: true, ws: true, proxyTimeout: 15 * 60_000, timeout: 15 * 60_000 });

  proxy.on("error", (err: Error, _req: any, res: any) => {
    log.warn(`proxy error: ${err.message}`);
    if (res && "writeHead" in res && !res.headersSent) {
      // Penpot itself is not reachable yet – explain what is going on instead of a bare 502.
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderStatusPage());
    } else if (res && "destroy" in res) {
      res.destroy();
    }
  });

  proxy.on("proxyRes", (proxyRes: http.IncomingMessage, req: http.IncomingMessage) => {
    const allowed = assetCorsOrigin(req.url ?? "", req.headers.origin);
    if (allowed) {
      proxyRes.headers["access-control-allow-origin"] = allowed;
      proxyRes.headers["access-control-allow-credentials"] = "true";
      proxyRes.headers["vary"] = "Origin";
    }
  });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    stripInternalHeaders(req.headers);
    try {
      const startup = bootstrapState();
      if (url === "/penpotos-health") {
        const ok = startup.status === "ready";
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, status: startup.status, problem: startup.problem?.title }));
        return;
      }
      // While PenpotOS cannot start (e.g. misconfiguration) show why on the main page and /penpotos-status.
      const isPage = req.method === "GET" && (url === "/" || url.startsWith("/?") || url.startsWith("/index.html"));
      if (url.startsWith("/penpotos-status") || (isPage && startup.status === "error")) {
        res.writeHead(startup.status === "ready" ? 200 : 503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderStatusPage());
        return;
      }
      const corsOrigin = assetCorsOrigin(url, req.headers.origin);
      if (req.method === "OPTIONS" && corsOrigin) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        });
        res.end();
        return;
      }
      const reason = await isBlocked(url);
      if (reason) {
        audit({ source: "system", action: "gateway.blocked", target: rpcCommandOf(url), detail: { ip: req.socket.remoteAddress } });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "restriction", code: "registration-disabled", hint: reason }));
        return;
      }
      proxy.web(req, res, { target: isMcpPath(url) ? mcpTarget : penpotTarget, changeOrigin: false });
    } catch (err: any) {
      log.error("gateway failure", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    stripInternalHeaders(req.headers);
    proxy.ws(req, socket, head, { target: penpotTarget.replace(/^http/, "ws") });
  });

  // Long-running MCP tool calls and SSE streams must not be cut by Node defaults.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(port, () => log.info(`gateway listening on :${port} → ${penpotTarget} (MCP → ${mcpTarget})`));
  return server;
}
