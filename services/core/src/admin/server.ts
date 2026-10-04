import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { createLogger } from "@penpotos/shared";
import { aiRouter } from "./pages-ai.ts";
import { miscRouter, publicRouter } from "./pages-misc.ts";
import { onboardingRouter } from "./pages-onboarding.ts";
import { teamsRouter } from "./pages-teams.ts";
import { usersRouter } from "./pages-users.ts";
import { requireAdmin } from "./session.ts";
import { setupRouter } from "./setup.ts";
import { bootstrapState, renderStatusPage } from "../bootstrap-state.ts";

const log = createLogger("admin");
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../static");

export function createAdminApp() {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use("/static", express.static(STATIC_DIR, { maxAge: "1h" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser());
  app.get("/healthz", (_req, res) => res.json({ ok: true, status: bootstrapState().status }));
  // Until PenpotOS has started (database, PREPL, accounts) every page shows the startup diagnostics.
  app.use((_req, res, next) => {
    if (bootstrapState().status === "ready") return next();
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.status(503).type("html").send(renderStatusPage());
  });
  app.use(setupRouter);
  app.use(publicRouter);
  app.use(requireAdmin);
  app.use(miscRouter, usersRouter, teamsRouter, onboardingRouter, aiRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error("request failed", err);
    res.status(500).send(`<pre>Chyba: ${String(err?.message ?? err).replace(/</g, "&lt;")}</pre>`);
  });
  return app;
}

export function startAdmin(port: number) {
  const app = createAdminApp();
  return app.listen(port, () => log.info(`admin dashboard listening on :${port}`));
}
