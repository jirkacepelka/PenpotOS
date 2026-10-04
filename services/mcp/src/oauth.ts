import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  PenpotRpc,
  audit,
  env,
  findValidToken,
  getProfile,
  getSettings,
  hmac,
  issueToken,
  query,
  queryOne,
  randomToken,
  revokeToken,
  safeEqual,
  sha256,
} from "@penpotos/shared";

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000;

class ClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string) {
    const row = await queryOne<{ data: OAuthClientInformationFull }>("SELECT data FROM penpotos.oauth_clients WHERE client_id = $1", [clientId]);
    return row?.data;
  }

  async registerClient(client: OAuthClientInformationFull) {
    await query("INSERT INTO penpotos.oauth_clients (client_id, data) VALUES ($1, $2)", [client.client_id, JSON.stringify(client)]);
    return client;
  }
}

function esc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The pending authorization request, signed so the login form cannot be tampered with. */
interface PendingAuth {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  exp: number;
}

function signPending(p: PendingAuth): string {
  const payload = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${payload}.${hmac("oauth:" + payload)}`;
}

function verifyPending(token: string): PendingAuth | undefined {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig || !safeEqual(sig, hmac("oauth:" + payload))) return undefined;
  const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PendingAuth;
  return p.exp > Date.now() ? p : undefined;
}

export function loginPage(pending: string, clientName: string | undefined, error?: string) {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Přihlášení – PenpotOS</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--panel:#fff;--text:#1a1a1a;--muted:#6b6b6b;--line:#e3e3df;--accent:#ffd200}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--panel:#1e1e1e;--text:#eee;--muted:#a0a0a0;--line:#333}}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}
.box{max-width:380px;margin:10vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 16px}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--text)}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#1a1a1a;font:inherit;font-weight:700;cursor:pointer}
.err{color:#c62828;border:1px solid #c62828;border-radius:8px;padding:8px 10px;margin-bottom:8px}
</style></head><body><div class="box">
<h1>◆ Penpot – připojení AI</h1>
<p>Aplikace <strong>${esc(clientName || "MCP klient")}</strong> chce pracovat s vašimi návrhy v Penpotu.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post" action="/penpotos-auth/login">
<input type="hidden" name="pending" value="${esc(pending)}">
<label>E-mail</label><input type="email" name="email" required autofocus>
<label>Heslo</label><input type="password" name="password" required>
<button>Přihlásit a povolit</button>
</form></div></body></html>`;
}

export class PenpotOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending = signPending({
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      exp: Date.now() + 15 * 60 * 1000,
    });
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    res.status(200).type("html").send(loginPage(pending, client.client_name));
  }

  private failures = new Map<string, { n: number; until: number }>();

  /** Handles the login form; on success redirects back to the client with an authorization code. */
  async handleLogin(req: Request, res: Response) {
    const ip = req.ip ?? "?";
    const f = this.failures.get(ip);
    if (f && f.until > Date.now() && f.n >= 8) {
      return res.status(429).type("html").send(loginPage(req.body?.pending ?? "", undefined, "Příliš mnoho pokusů, zkus to za pár minut."));
    }
    const fail = () => {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60_000 };
      cur.n++;
      this.failures.set(ip, cur);
    };
    const pending = verifyPending(req.body?.pending);
    if (!pending) return res.status(400).type("html").send(loginPage("", undefined, "Platnost přihlašovacího formuláře vypršela. Začni připojení znovu."));
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    let profileId: string;
    try {
      const rpc = new PenpotRpc(env.penpotBackendUrl);
      const profile: any = await rpc.login(email, String(req.body?.password ?? ""));
      rpc.call("logout").catch(() => {});
      profileId = profile.id;
    } catch {
      fail();
      return res.status(401).type("html").send(loginPage(req.body.pending, pending.clientName, "Neplatný e-mail nebo heslo."));
    }
    this.failures.delete(ip);
    const member = await getProfile(profileId);
    const settings = await getSettings();
    if (!settings.ai.mcpEnabled) return res.status(403).type("html").send(loginPage(req.body.pending, pending.clientName, "AI integrace je vypnutá administrátorem."));
    if (!member?.aiAccess || member.isBlocked || member.isService) {
      return res.status(403).type("html").send(loginPage(req.body.pending, pending.clientName, "Tento účet nemá povolený přístup k AI. Požádej administrátora."));
    }
    const code = randomToken(32);
    await query(
      `INSERT INTO penpotos.oauth_codes (code_hash, client_id, profile_id, code_challenge, redirect_uri, scopes, resource, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sha256(code), pending.clientId, profileId, pending.codeChallenge, pending.redirectUri, pending.scopes, pending.resource ?? null, new Date(Date.now() + CODE_TTL_MS)],
    );
    await audit({ source: "mcp", actor: member.email, action: "oauth.authorize", target: pending.clientName ?? pending.clientId });
    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state) target.searchParams.set("state", pending.state);
    res.redirect(302, target.href);
  }

  private async getCode(client: OAuthClientInformationFull, code: string) {
    const row = await queryOne<{ clientId: string; profileId: string; codeChallenge: string; redirectUri: string; scopes: string[]; expiresAt: Date }>(
      `SELECT client_id AS "clientId", profile_id AS "profileId", code_challenge AS "codeChallenge", redirect_uri AS "redirectUri", scopes, expires_at AS "expiresAt"
         FROM penpotos.oauth_codes WHERE code_hash = $1`,
      [sha256(code)],
    );
    if (!row || row.clientId !== client.client_id || row.expiresAt.getTime() < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return (await this.getCode(client, authorizationCode)).codeChallenge;
  }

  private async issuePair(clientId: string, profileId: string, scopes: string[], clientName?: string): Promise<OAuthTokens> {
    const access = await issueToken({ kind: "oauth_access", profileId, clientId, scopes, ttlSeconds: ACCESS_TTL });
    const refresh = await issueToken({ kind: "oauth_refresh", profileId, clientId, scopes, ttlSeconds: REFRESH_TTL, name: clientName });
    return { access_token: access.token, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh.token, scope: scopes.join(" ") || undefined };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = await this.getCode(client, authorizationCode);
    await query("DELETE FROM penpotos.oauth_codes WHERE code_hash = $1", [sha256(authorizationCode)]);
    if (redirectUri && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issuePair(client.client_id, row.profileId, row.scopes, client.client_name);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const t = await findValidToken(refreshToken, ["oauth_refresh"]);
    if (!t || t.clientId !== client.client_id || !t.profileId) throw new InvalidGrantError("Invalid refresh token");
    const member = await getProfile(t.profileId);
    if (!member?.aiAccess || member.isBlocked) throw new InvalidGrantError("AI access revoked");
    await revokeToken(refreshToken); // rotation
    return this.issuePair(client.client_id, t.profileId, scopes ?? t.scopes, client.client_name);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = await findValidToken(token, ["oauth_access", "api"]);
    if (!t || !t.profileId) throw new InvalidTokenError("Invalid or expired token");
    const member = await getProfile(t.profileId);
    if (!member?.aiAccess || member.isBlocked) throw new InvalidTokenError("AI access revoked for this account");
    return {
      token,
      clientId: t.clientId ?? "api-token",
      scopes: t.scopes,
      expiresAt: Math.floor((t.expiresAt?.getTime() ?? Date.now() + 3600_000) / 1000),
      extra: { profileId: t.profileId, email: member.email, fullname: member.fullname },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await revokeToken(request.token);
  }
}
