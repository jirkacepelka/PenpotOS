import { env } from "./env.ts";
import { query, queryOne } from "./db.ts";
import { randomToken, safeEqual, sha256 } from "./crypto.ts";

/** Header used for service-to-service calls inside the compose network. */
export const INTERNAL_HEADER = "x-penpotos-internal";

export function isInternalRequest(headerValue: string | string[] | undefined): boolean {
  const expected = env.internalToken;
  if (!expected || typeof headerValue !== "string") return false;
  return safeEqual(headerValue, expected);
}

export type TokenKind = "api" | "oauth_access" | "oauth_refresh";

export interface StoredToken {
  tokenHash: string;
  kind: TokenKind;
  name: string | null;
  clientId: string | null;
  profileId: string | null;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const TOKEN_SELECT = `SELECT token_hash AS "tokenHash", kind, name, client_id AS "clientId", profile_id AS "profileId",
  scopes, expires_at AS "expiresAt", revoked_at AS "revokedAt", last_used_at AS "lastUsedAt", created_at AS "createdAt"
  FROM penpotos.tokens`;

/** Creates a token and returns its clear-text value (only the hash is stored). */
export async function issueToken(data: {
  kind: TokenKind;
  profileId: string;
  name?: string;
  clientId?: string;
  scopes?: string[];
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: Date | null }> {
  const prefix = data.kind === "api" ? "ppos_" : data.kind === "oauth_access" ? "ppat_" : "pprt_";
  const token = prefix + randomToken(32);
  const expiresAt = data.ttlSeconds ? new Date(Date.now() + data.ttlSeconds * 1000) : null;
  await query(
    `INSERT INTO penpotos.tokens (token_hash, kind, name, client_id, profile_id, scopes, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(token), data.kind, data.name ?? null, data.clientId ?? null, data.profileId, data.scopes ?? [], expiresAt],
  );
  return { token, expiresAt };
}

/** Looks up a valid (not expired / revoked) token. */
export async function findValidToken(token: string, kinds: TokenKind[]): Promise<StoredToken | undefined> {
  const row = await queryOne<StoredToken>(
    `${TOKEN_SELECT} WHERE token_hash = $1 AND kind = ANY($2) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [sha256(token), kinds],
  );
  if (row) {
    query("UPDATE penpotos.tokens SET last_used_at = now() WHERE token_hash = $1", [row.tokenHash]).catch(() => {});
  }
  return row;
}

export async function revokeTokenHash(tokenHash: string): Promise<void> {
  await query("UPDATE penpotos.tokens SET revoked_at = now() WHERE token_hash = $1", [tokenHash]);
}

export async function revokeToken(token: string): Promise<void> {
  await revokeTokenHash(sha256(token));
}

export async function revokeProfileTokens(profileId: string): Promise<void> {
  await query("UPDATE penpotos.tokens SET revoked_at = now() WHERE profile_id = $1 AND revoked_at IS NULL", [profileId]);
}

export async function listActiveTokens() {
  return query<StoredToken & { email: string | null; fullname: string | null }>(
    `SELECT t.token_hash AS "tokenHash", t.kind, t.name, t.client_id AS "clientId", t.profile_id AS "profileId", t.scopes,
            t.expires_at AS "expiresAt", t.revoked_at AS "revokedAt", t.last_used_at AS "lastUsedAt", t.created_at AS "createdAt",
            p.email, p.fullname
       FROM penpotos.tokens t LEFT JOIN profile p ON p.id = t.profile_id
      WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND t.kind IN ('api', 'oauth_refresh')
      ORDER BY t.created_at DESC`,
  );
}
