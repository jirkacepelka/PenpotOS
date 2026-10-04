import { Router, type Request } from "express";
import { audit, env, queryOne, randomToken, safeEqual, writeConfigFile } from "@penpotos/shared";
import { createMember } from "../members.ts";
import { runSync } from "../sync.ts";
import { html, layout } from "./html.ts";
import { setFlash, startSession } from "./session.ts";

let adminExists = false;

/** True once at least one active PenpotOS administrator exists. */
export async function hasAdmin(): Promise<boolean> {
  if (adminExists) return true;
  const row = await queryOne(
    `SELECT 1 FROM penpotos.members m JOIN profile p ON p.id = m.profile_id
      WHERE m.role = 'admin' AND p.deleted_at IS NULL AND NOT coalesce(p.is_blocked, false) LIMIT 1`,
  );
  adminExists = !!row;
  return adminExists;
}

/** Normalises an address typed by the admin ("penpot.cz" → "https://penpot.cz"). */
export function normalizePublicUrl(input: string): string {
  let v = input.trim();
  if (!v) throw new Error("Zadej veřejnou adresu.");
  if (!/^https?:\/\//i.test(v)) v = (/^[\d.]+(:\d+)?$|^localhost/i.test(v) ? "http://" : "https://") + v;
  const u = new URL(v);
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("Adresa nesmí obsahovat cestu, jen např. https://penpot.voluntia.cz");
  return u.origin;
}

/** Saves the public address (unless pinned by PENPOTOS_PUBLIC_URL). Returns true when it changed. */
export function savePublicUrl(input: string): boolean {
  if (env.publicUrlFromEnv) return false;
  const url = normalizePublicUrl(input);
  const changed = url !== env.publicUrl || !env.publicUrlConfigured;
  writeConfigFile("public_url", url);
  return changed;
}

/** Guess of the Penpot address based on how the admin dashboard was opened. */
export function suggestedPublicUrl(req: Request): string {
  if (env.publicUrlConfigured) return env.publicUrl;
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0];
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "localhost").split(",")[0];
  const hostname = host.replace(/:\d+$/, "");
  return `${proto}://${hostname}:${env.str("PENPOTOS_GATEWAY_PUBLIC_PORT", "9001")}`;
}

const SETUP_COOKIE = "ppos_setup";

const page = (token: string, values: Record<string, string>, error?: string) =>
  layout(
    { title: "První spuštění" },
    html`<div class="login card">
      <h1><span class="logo">◆</span> Vítej v PenpotOS</h1>
      <p>Vytvoř prvního administrátora. Tímto účtem se přihlásíš do admin dashboardu i do Penpotu.</p>
      ${error ? html`<div class="flash error">${error}</div>` : ""}
      <form method="post" action="/setup">
        <input type="hidden" name="_setup" value="${token}">
        <label>Jméno a příjmení</label><input type="text" name="fullname" value="${values.fullname ?? ""}" required autofocus>
        <label>E-mail</label><input type="email" name="email" value="${values.email ?? ""}" required>
        <label>Heslo (min. 8 znaků)</label><input type="password" name="password" minlength="8" required>
        <label>Heslo znovu</label><input type="password" name="password2" minlength="8" required>
        <label>Adresa, na které budou členové Penpot otevírat</label>
        ${env.publicUrlFromEnv
          ? html`<input type="text" value="${env.publicUrl}" disabled><p class="hint">Nastaveno proměnnou PENPOTOS_PUBLIC_URL.</p>`
          : html`<input type="text" name="publicUrl" value="${values.publicUrl ?? ""}" required>
            <p class="hint">Zatím může zůstat adresa v lokální síti. Až zprovozníš Cloudflare Tunnel, změníš ji v Přehledu (např. https://penpot.voluntia.cz).</p>`}
        <div class="actions"><button class="primary">Vytvořit administrátora</button></div>
      </form>
      <p class="hint">Tato stránka je dostupná jen do vytvoření prvního administrátora.</p>
    </div>`,
  );

export const setupRouter = Router();

/** While no administrator exists, every admin page leads to the setup wizard. */
setupRouter.use(async (req, res, next) => {
  if (req.path.startsWith("/static") || (await hasAdmin())) return next();
  if (req.path === "/setup") return next();
  return res.redirect("/setup");
});

setupRouter.get("/setup", async (req, res) => {
  if (await hasAdmin()) return res.redirect("/");
  const token = randomToken(18);
  res.cookie(SETUP_COOKIE, token, { httpOnly: true, sameSite: "strict", maxAge: 60 * 60 * 1000, path: "/" });
  res.send(page(token, { publicUrl: suggestedPublicUrl(req) }));
});

setupRouter.post("/setup", async (req, res) => {
  if (await hasAdmin()) return res.redirect("/");
  const b = req.body ?? {};
  const token = String(req.cookies?.[SETUP_COOKIE] ?? "");
  const values = { fullname: String(b.fullname ?? ""), email: String(b.email ?? ""), publicUrl: String(b.publicUrl ?? "") };
  const fail = (msg: string) => res.status(400).send(page(token, values, msg));
  if (!token || !safeEqual(token, String(b._setup ?? ""))) return fail("Formulář vypršel, zkus to prosím znovu.");
  if (String(b.password ?? "") !== String(b.password2 ?? "")) return fail("Hesla se neshodují.");
  try {
    if (!env.publicUrlFromEnv) normalizePublicUrl(values.publicUrl);
    const { profileId } = await createMember(
      { fullname: values.fullname, email: values.email, password: String(b.password ?? ""), role: "admin", aiAccess: true },
      "setup",
    );
    const changed = env.publicUrlFromEnv ? false : savePublicUrl(values.publicUrl);
    adminExists = true;
    await audit({ source: "admin", actor: values.email, action: "setup.complete", detail: { publicUrl: env.publicUrl } });
    runSync("setup").catch(() => {});
    res.clearCookie(SETUP_COOKIE, { path: "/" });
    startSession(req, res, profileId);
    setFlash(
      res,
      "ok",
      "Administrátor vytvořen. " +
        (changed ? "Aby Penpot používal novou adresu i v odkazech a exportech, restartuj jednou aplikaci PenpotOS v ZimaOS." : ""),
    );
    res.redirect("/");
  } catch (err: any) {
    fail(err.message);
  }
});
