/**
 * Environment configuration shared by all PenpotOS services.
 * Every value has a default matching the bundled docker-compose.yml.
 */
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
  /** Public base URL of the Penpot instance as users see it (through the PenpotOS gateway). */
  get publicUrl() {
    return str("PENPOTOS_PUBLIC_URL", "http://localhost:9001").replace(/\/+$/, "");
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
    return str("PENPOTOS_DATABASE_URL", "postgresql://penpot:penpot@penpot-postgres:5432/penpot");
  },
  /** Secret used to encrypt API keys stored in the database and to sign admin sessions. */
  get secretKey() {
    return str("PENPOTOS_SECRET_KEY", "");
  },
  /** Shared secret for service-to-service calls (core <-> mcp <-> discord). */
  get internalToken() {
    return str("PENPOTOS_INTERNAL_TOKEN", "");
  },
  get mcpInternalUrl() {
    return str("PENPOTOS_MCP_INTERNAL_URL", "http://penpotos-mcp:4400").replace(/\/+$/, "");
  },
  get bootstrapAdminEmail() {
    return str("PENPOTOS_ADMIN_EMAIL", "");
  },
  get bootstrapAdminPassword() {
    return str("PENPOTOS_ADMIN_PASSWORD", "");
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
