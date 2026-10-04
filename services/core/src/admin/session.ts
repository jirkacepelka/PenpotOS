import type { NextFunction, Request, Response } from "express";
import { PenpotRpc, env, getProfile, hmac, randomToken, safeEqual } from "@penpotos/shared";

const COOKIE = "ppos_admin";
const TTL_MS = 12 * 60 * 60 * 1000;

export interface AdminSession {
  pid: string;
  exp: number;
  csrf: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: { id: string; email: string; fullname: string; csrf: string };
    }
  }
}

function encode(s: AdminSession): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${hmac("admin:" + payload)}`;
}

function decode(value: string | undefined): AdminSession | undefined {
  if (!value) return undefined;
  const [payload, sig] = value.split(".");
  if (!payload || !sig || !safeEqual(sig, hmac("admin:" + payload))) return undefined;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdminSession;
    return s.exp > Date.now() ? s : undefined;
  } catch {
    return undefined;
  }
}

function secureCookies(req: Request) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/** Verifies Penpot credentials and checks the PenpotOS admin role. */
export async function verifyAdminCredentials(email: string, password: string) {
  const rpc = new PenpotRpc(env.penpotBackendUrl);
  const profile = await rpc.login(email.trim().toLowerCase(), password);
  rpc.call("logout").catch(() => {});
  const row = await getProfile(profile.id);
  if (!row || row.role !== "admin") throw new Error("Tento účet nemá administrátorská práva.");
  if (row.isBlocked) throw new Error("Účet je zablokovaný.");
  return row;
}

export function startSession(req: Request, res: Response, profileId: string) {
  const s: AdminSession = { pid: profileId, exp: Date.now() + TTL_MS, csrf: randomToken(18) };
  res.cookie(COOKIE, encode(s), { httpOnly: true, sameSite: "lax", secure: secureCookies(req), maxAge: TTL_MS, path: "/" });
}

export function endSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

/** Loads the admin session; redirects anonymous users to /login and enforces CSRF on POST. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const s = decode(req.cookies?.[COOKIE]);
  const row = s ? await getProfile(s.pid).catch(() => undefined) : undefined;
  if (!s || !row || row.role !== "admin" || row.isBlocked) {
    if (req.method === "GET") return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).send("Nepřihlášen");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const token = (req.body?._csrf as string) ?? req.get("x-csrf-token");
    if (!token || !safeEqual(token, s.csrf)) return res.status(403).send("Neplatný CSRF token – obnov stránku a zkus to znovu.");
  }
  req.admin = { id: row.id, email: row.email, fullname: row.fullname, csrf: s.csrf };
  next();
}

const FLASH = "ppos_flash";

export function setFlash(res: Response, kind: "ok" | "error" | "info", text: string) {
  res.cookie(FLASH, Buffer.from(JSON.stringify({ kind, text })).toString("base64url"), { httpOnly: true, sameSite: "lax", maxAge: 60_000, path: "/" });
}

export function takeFlash(req: Request, res: Response): { kind: "ok" | "error" | "info"; text: string } | null {
  const v = req.cookies?.[FLASH];
  if (!v) return null;
  res.clearCookie(FLASH, { path: "/" });
  try {
    return JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
