const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

function fmt(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return ` ${data.stack ?? data.message}`;
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " " + String(data);
  }
}

export function createLogger(scope: string): Logger {
  const log = (level: Level, msg: string, data?: unknown) => {
    if (LEVELS[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${fmt(data)}`;
    (level === "error" || level === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, d) => log("debug", m, d),
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
  };
}
