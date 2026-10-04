import fs from "node:fs";
import path from "node:path";

/**
 * Environment configuration shared by all PenpotOS services.
 * Every value has a default matching the bundled docker-compose.yml.
 *
 * Secrets and the public URL can also come from files in the shared config
 * volume (PENPOTOS_CONFIG_DIR, default /config) – written by `penpotos-init`
 * and the admin dashboard – so the compose file needs no hand-edited values.
 */

/** Values like "ZMEN-…" in the example compose files are treated as not set. */
export function isPlaceholder(value: string | undefined): boolean {
  return !value || value.startsWith("ZMEN-");
}

export function configDir(): string {
  return process.env.PENPOTOS_CONFIG_DIR || "/config";
}

const fileCache = new Map<string, { at: number; value: string | undefined }>();

/** Reads a value from the shared config volume (cached for a few seconds). */
export function readConfigFile(name: string, maxAgeMs = 5_000): string | undefined {
  const cached = fileCache.get(name);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  let value: string | undefined;
  try {
    value = fs.readFileSync(path.join(configDir(), name), "utf8").trim() || undefined;
  } catch {
    value = undefined;
  }
  fileCache.set(name, { at: Date.now(), value });
  return value;
}

/** Writes a value into the shared config volume (core service only). */
export function writeConfigFile(name: string, value: string, mode = 0o644): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = path.join(configDir(), name);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value.trim() + "\n", { mode });
  fs.renameSync(tmp, target);
  fileCache.delete(name);
}

/** Environment variable unless empty/placeholder, otherwise the config file. */
function envOrFile(name: string, file: string): string {
  const v = process.env[name];
  if (!isPlaceholder(v)) return v!;
  return readConfigFile(file, 60_000) ?? "";
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  /**
   * Public base URL of the Penpot instance as users see it (through the PenpotOS gateway):
   * PENPOTOS_PUBLIC_URL, else the address saved in the admin dashboard, else localhost.
   */
  get publicUrl() {
    const fromEnv = process.env.PENPOTOS_PUBLIC_URL;
    const value = !isPlaceholder(fromEnv) ? fromEnv! : (readConfigFile("public_url") ?? "http://localhost:9001");
    return value.replace(/\/+$/, "");
  },
  /** True when the public URL is pinned by the environment (not editable in the admin). */
  get publicUrlFromEnv() {
    return !isPlaceholder(process.env.PENPOTOS_PUBLIC_URL);
  },
  /** True when an address was saved (env or admin dashboard). */
  get publicUrlConfigured() {
    return this.publicUrlFromEnv || !!readConfigFile("public_url");
  },
  /** Internal URL of the penpot-frontend container (serves UI and proxies /api to the backend). */
  get penpotInternalUrl() {
    return str("PENPOT_INTERNAL_URL", "http://penpot-frontend:8080").replace(/\/+$/, "");
  },
  /** Internal URL of the penpot-backend container (RPC API without the gateway's registration block). */
  get penpotBackendUrl() {
    return str("PENPOT_BACKEND_URL", "http://penpot-backend:6060").replace(/\/+$/, "");
  },
  get preplHost() {
    return str("PENPOT_PREPL_HOST", "penpot-backend");
  },
  get preplPort() {
    return int("PENPOT_PREPL_PORT", 6063);
  },
  get databaseUrl() {
    const url = process.env.PENPOTOS_DATABASE_URL;
    if (url) return url;
    // Alternative to a full URL: password from the environment or the generated config file.
    const password = encodeURIComponent(envOrFile("PENPOTOS_DATABASE_PASSWORD", "postgres_password") || "penpot");
    return `postgresql://penpot:${password}@${str("PENPOTOS_DATABASE_HOST", "penpot-postgres")}:5432/penpot`;
  },
  /** Secret used to encrypt API keys stored in the database and to sign admin sessions. */
  get secretKey() {
    return envOrFile("PENPOTOS_SECRET_KEY", "penpotos_secret_key");
  },
  /** Shared secret for service-to-service calls (core <-> mcp <-> discord). */
  get internalToken() {
    return envOrFile("PENPOTOS_INTERNAL_TOKEN", "internal_token");
  },
  get mcpInternalUrl() {
    return str("PENPOTOS_MCP_INTERNAL_URL", "http://penpotos-mcp:4400").replace(/\/+$/, "");
  },
  /** Optional first administrator from the environment (otherwise the setup wizard is used). */
  get bootstrapAdminEmail() {
    const v = process.env.PENPOTOS_ADMIN_EMAIL;
    return isPlaceholder(v) || v === "admin@example.com" ? "" : v!;
  },
  get bootstrapAdminPassword() {
    const v = process.env.PENPOTOS_ADMIN_PASSWORD;
    return isPlaceholder(v) ? "" : v!;
  },
  get bootstrapAdminName() {
    return str("PENPOTOS_ADMIN_NAME", "Administrátor");
  },
  get botEmail() {
    return str("PENPOTOS_BOT_EMAIL", "ai@penpotos.local");
  },
  get botName() {
    return str("PENPOTOS_BOT_NAME", "Voluntia AI");
  },
  get logLevel() {
    return str("LOG_LEVEL", "info");
  },
  int,
  str,
};
