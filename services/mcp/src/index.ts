import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { INTERNAL_HEADER, createLogger, env, getSettings, isInternalRequest, migrate, waitForDatabase } from "@penpotos/shared";
import { applyBrandLibrary } from "./brand.ts";
import { browserPool } from "./browser.ts";
import { PenpotOAuthProvider } from "./oauth.ts";
import { createMcpServer, type Caller } from "./tools.ts";

const log = createLogger("mcp");

// The SDK refuses non-HTTPS issuers; plain HTTP is only acceptable for LAN testing.
const publicUrl = new URL(env.publicUrl);
if (publicUrl.protocol === "http:") process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL = "true";
const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");

const provider = new PenpotOAuthProvider();
const mcpUrl = new URL("/mcp", publicUrl);
const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).href;

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

function unauthorized(res: Response, description: string) {
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer error="invalid_token", error_description="${description.replace(/"/g, "'")}", resource_metadata="${resourceMetadataUrl}"`)
    .json({ error: "invalid_token", error_description: description });
}

/** Accepts OAuth access tokens, PenpotOS API tokens, or the internal service token (Discord bot). */
async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    if (isInternalRequest(req.get(INTERNAL_HEADER))) {
      const actor = req.get("x-penpotos-actor") ?? "internal";
      req.caller = { actor, source: "discord", storageKey: `internal:${req.get("x-penpotos-storage") ?? actor}` };
      return next();
    }
    const header = req.get("authorization");
    const m = header?.match(/^Bearer\s+(.+)$/i);
    if (!m) return unauthorized(res, "Missing Authorization header");
    const info = await provider.verifyAccessToken(m[1].trim());
    const extra = info.extra as { profileId: string; email: string };
    req.caller = { actor: extra.email, profileId: extra.profileId, source: "mcp", storageKey: `user:${extra.profileId}` };
    next();
  } catch (err: any) {
    unauthorized(res, err.message ?? "Invalid token");
  }
}

const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: ["penpot"],
    resourceName: "Penpot (PenpotOS)",
  }),
);
app.post("/penpotos-auth/login", express.urlencoded({ extended: false }), (req, res, next) => {
  provider.handleLogin(req, res).catch(next);
});

app.post("/mcp", express.json({ limit: "40mb" }), authenticate, async (req, res) => {
  const settings = await getSettings();
  if (!settings.ai.mcpEnabled) {
    return res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "AI integrace je vypnutá v admin dashboardu PenpotOS." }, id: null });
  }
  try {
    const server = await createMcpServer(req.caller!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    log.error("MCP request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
app.all("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

// ---- internal endpoints (core service / health checks) ----
const internal = express.Router();
internal.use((req, res, next) => (isInternalRequest(req.get(INTERNAL_HEADER)) ? next() : res.status(403).json({ error: "forbidden" })));
internal.get("/status", async (_req, res) => {
  const settings = await getSettings().catch(() => undefined);
  const status = browserPool.status();
  res.json({
    ok: true,
    detail: settings?.ai.mcpEnabled === false ? "MCP vypnuto v nastavení" : `MCP běží, otevřené soubory: ${status.openFiles}`,
    browser: status,
  });
});
internal.post("/brand-library", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { fileId, palette, typographies } = req.body ?? {};
    const report = await applyBrandLibrary(String(fileId), palette ?? [], typographies ?? []);
    res.json({ ok: true, report });
  } catch (err: any) {
    log.warn(`brand library update failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.use("/internal", internal);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  log.error("request failed", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

async function main() {
  await waitForDatabase();
  await migrate();
  const port = env.int("PENPOTOS_MCP_PORT", 4400);
  const server = app.listen(port, () => log.info(`MCP server listening on :${port} (public endpoint ${mcpUrl.href})`));
  server.requestTimeout = 0;
  const stop = async () => {
    log.info("shutting down");
    server.close();
    await browserPool.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log.error("startup failed", err);
  process.exit(1);
});
