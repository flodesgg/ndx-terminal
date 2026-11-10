/**
 * LOG viewer data (SPEC §11): the server writes one JSON object per line (ts, level, logger,
 * msg, exc; secrets already redacted). Lines that are not JSON are kept as raw text.
 */

export const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  ts: string | null;
  level: LogLevel;
  logger: string;
  msg: string;
  exc?: string;
}

const isLevel = (v: unknown): v is LogLevel =>
  typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);

export function parseLogLine(line: string): LogEntry | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o && typeof o === "object" && typeof o.msg === "string") {
      return {
        ts: typeof o.ts === "string" ? o.ts : null,
        level: isLevel(o.level) ? o.level : "INFO",
        logger: typeof o.logger === "string" ? o.logger : "",
        msg: o.msg,
        exc: typeof o.exc === "string" ? o.exc : undefined,
      };
    }
  } catch {
    /* not JSON: raw text below */
  }
  return { ts: null, level: "INFO", logger: "", msg: line, exc: undefined };
}

export function filterLog(entries: readonly LogEntry[], min: LogLevel, text: string): LogEntry[] {
  const floor = LOG_LEVELS.indexOf(min);
  const q = text.trim().toLowerCase();
  return entries.filter(
    (e) =>
      LOG_LEVELS.indexOf(e.level) >= floor &&
      (!q || `${e.logger} ${e.msg} ${e.exc ?? ""}`.toLowerCase().includes(q)),
  );
}

const ALIASES: Record<string, LogLevel> = { WARN: "WARNING", ERR: "ERROR", CRIT: "CRITICAL" };
/** The server returns at most this many lines (`/logs?lines=` cap). */
export const LOG_MAX_LINES = 5000;

export function logArgs(args: readonly string[]): { lines: number; level: LogLevel } {
  let lines = 400;
  let level: LogLevel = "DEBUG";
  for (const raw of args) {
    const a = raw.toUpperCase();
    if (/^\d+$/.test(a)) lines = Math.min(LOG_MAX_LINES, Math.max(1, Number(a)));
    else if (isLevel(a)) level = a;
    else if (ALIASES[a]) level = ALIASES[a];
  }
  return { lines, level };
}
