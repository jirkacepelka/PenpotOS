import pg from "pg";
import { env } from "./env.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("db");

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
    pool.on("error", (err) => log.error("idle client error", err));
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/**
 * PenpotOS keeps its own tables in the `penpotos` schema of the Penpot database.
 * Penpot's own migrations never touch this schema.
 */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE penpotos.settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE penpotos.members (
        profile_id uuid PRIMARY KEY,
        role text NOT NULL DEFAULT 'member',
        ai_access boolean NOT NULL DEFAULT true,
        is_service boolean NOT NULL DEFAULT false,
        note text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        onboarded_at timestamptz
      );
      CREATE TABLE penpotos.oauth_clients (
        client_id text PRIMARY KEY,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE penpotos.oauth_codes (
        code_hash text PRIMARY KEY,
        client_id text NOT NULL,
        profile_id uuid NOT NULL,
        code_challenge text NOT NULL,
        redirect_uri text NOT NULL,
        scopes text[] NOT NULL DEFAULT '{}',
        resource text,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE penpotos.tokens (
        token_hash text PRIMARY KEY,
        kind text NOT NULL,
        name text,
        client_id text,
        profile_id uuid,
        scopes text[] NOT NULL DEFAULT '{}',
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tokens_profile_idx ON penpotos.tokens (profile_id);
      CREATE TABLE penpotos.audit_log (
        id bigserial PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        source text NOT NULL,
        actor text,
        action text NOT NULL,
        target text,
        ok boolean NOT NULL DEFAULT true,
        duration_ms integer,
        detail jsonb
      );
      CREATE INDEX audit_log_ts_idx ON penpotos.audit_log (ts DESC);
      CREATE TABLE penpotos.conversations (
        id text PRIMARY KEY,
        source text NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query("CREATE SCHEMA IF NOT EXISTS penpotos");
    await client.query(
      "CREATE TABLE IF NOT EXISTS penpotos.migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT id FROM penpotos.migrations")).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log.info(`applying migration ${m.id}`);
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO penpotos.migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}

/** Waits until the database (and Penpot's own schema) is reachable. */
export async function waitForDatabase(timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await query("SELECT 1 FROM profile LIMIT 1");
      return;
    } catch (err: any) {
      // A wrong password will not fix itself – report it right away.
      if (err?.code === "28P01" || Date.now() - start > timeoutMs) throw err;
      log.info("waiting for Penpot database…");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
