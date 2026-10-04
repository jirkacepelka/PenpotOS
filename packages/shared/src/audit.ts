import { query } from "./db.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("audit");

export interface AuditEntry {
  source: "admin" | "mcp" | "discord" | "system";
  actor?: string | null;
  action: string;
  target?: string | null;
  ok?: boolean;
  durationMs?: number;
  detail?: unknown;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO penpotos.audit_log (source, actor, action, target, ok, duration_ms, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.source,
        entry.actor ?? null,
        entry.action,
        entry.target ?? null,
        entry.ok ?? true,
        entry.durationMs ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      ],
    );
  } catch (err) {
    log.warn("failed to write audit entry", err);
  }
}

export async function recentAudit(limit = 200, source?: string) {
  return query(
    `SELECT id, ts, source, actor, action, target, ok, duration_ms AS "durationMs", detail
       FROM penpotos.audit_log ${source ? "WHERE source = $2" : ""} ORDER BY ts DESC LIMIT $1`,
    source ? [limit, source] : [limit],
  );
}
