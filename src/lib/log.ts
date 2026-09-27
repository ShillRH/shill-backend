// Minimal structured logger (JSON lines). Swap for pino if you prefer.
type Level = "debug" | "info" | "warn" | "error";
function write(level: Level, msg: string, data?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), level, msg, ...(data ?? {}) };
  (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(line));
}
export const log = {
  debug: (m: string, d?: Record<string, unknown>) => { if (process.env.DEBUG) write("debug", m, d); },
  info: (m: string, d?: Record<string, unknown>) => write("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => write("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => write("error", m, d),
};
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
