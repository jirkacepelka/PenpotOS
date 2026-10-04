import { query, queryOne } from "./db.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";

/**
 * Internal key/value state stored next to settings (keys prefixed with
 * "state:" or "secret:"); never exposed through the settings API.
 */
export async function getState<T>(key: string): Promise<T | undefined> {
  const row = await queryOne<{ value: any }>("SELECT value FROM penpotos.settings WHERE key = $1", ["state:" + key]);
  return row?.value as T | undefined;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO penpotos.settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ["state:" + key, JSON.stringify(value)],
  );
}

export async function getSecret(key: string): Promise<string | undefined> {
  const row = await queryOne<{ value: any }>("SELECT value FROM penpotos.settings WHERE key = $1", ["secret:" + key]);
  return typeof row?.value === "string" ? decryptSecret(row.value) : undefined;
}

export async function setSecret(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO penpotos.settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ["secret:" + key, JSON.stringify(encryptSecret(value))],
  );
}
