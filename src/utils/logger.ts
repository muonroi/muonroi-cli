import fs from "fs";
import * as os from "os";
import * as path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogNamespace = "cli" | "ui" | "orchestrator" | "storage" | "ee" | "mcp" | "pil" | "router";

export interface LogContext {
  elapsedMs?: number;
  error?: Error | unknown;
  [key: string]: unknown;
}

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default log level is 'info' unless explicitly configured.
const CURRENT_WEIGHT = (() => {
  const envLevel = process.env.MUONROI_LOG_LEVEL?.toLowerCase();
  if (envLevel === "debug") return LEVEL_WEIGHTS.debug;
  if (envLevel === "info") return LEVEL_WEIGHTS.info;
  if (envLevel === "warn") return LEVEL_WEIGHTS.warn;
  if (envLevel === "error") return LEVEL_WEIGHTS.error;
  return LEVEL_WEIGHTS.info;
})();

/**
 * Checks if the given log level is enabled based on the current process level weight.
 */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return LEVEL_WEIGHTS[level] >= CURRENT_WEIGHT;
}

/**
 * Redacts common patterns of API keys and credential strings from log messages.
 */
export function redactSecrets(str: string): string {
  return str
    .replace(/\bsk-[A-Za-z0-9-_]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bxai-[A-Za-z0-9-_]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bAIzaSy[A-Za-z0-9-_]{30,}\b/g, "[REDACTED_API_KEY]");
}

/**
 * Recursively redacts sensitive fields from context objects.
 */
export function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return redactSecrets(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }
  if (typeof obj === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lowerK = k.toLowerCase();
      if (
        lowerK.includes("key") ||
        lowerK.includes("secret") ||
        lowerK.includes("token") ||
        lowerK.includes("password") ||
        lowerK.includes("auth")
      ) {
        res[k] = "[REDACTED]";
      } else {
        res[k] = redactObject(v);
      }
    }
    return res;
  }
  return obj;
}

/**
 * Returns true if the interactive TUI is active, preventing console writes.
 */
function isTuiActive(): boolean {
  try {
    return (globalThis as Record<string, unknown>).__muonroiTuiActive === true;
  } catch {
    return false;
  }
}

/**
 * Writes logs safely to ~/.muonroi-cli/debug.log.
 */
function appendToFile(level: LogLevel, ns: LogNamespace, msg: string, ctx?: LogContext): void {
  try {
    const dir = path.join(os.homedir(), ".muonroi-cli");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const logPath = path.join(dir, "debug.log");
    const ts = new Date().toISOString();
    const redactedCtx = ctx ? redactObject(ctx) : null;
    const ctxStr = redactedCtx ? ` ${JSON.stringify(redactedCtx)}` : "";
    const logLine = `[${ts}] [${level.toUpperCase()}] [${ns.toUpperCase()}] ${redactSecrets(msg)}${ctxStr}\n`;
    fs.appendFileSync(logPath, logLine, "utf8");
  } catch {
    /* fail-open */
  }
}

/**
 * Formats console log lines with colors.
 */
function formatConsole(level: LogLevel, ns: LogNamespace, msg: string, ctx?: LogContext): string {
  const ts = new Date().toISOString().split("T")[1].slice(0, -1); // HH:MM:SS.mmm
  const levelStr = level.toUpperCase();
  const nsStr = ns.toUpperCase();
  const cleanMsg = redactSecrets(msg);
  const redactedCtx = ctx ? redactObject(ctx) : null;
  const ctxStr = redactedCtx ? ` ${JSON.stringify(redactedCtx)}` : "";

  // Apply colors for developer convenience in terminal logs (non-TUI)
  let color = "\x1b[0m"; // Reset
  if (level === "debug") color = "\x1b[90m"; // Gray
  if (level === "info") color = "\x1b[32m"; // Green
  if (level === "warn") color = "\x1b[33m"; // Yellow
  if (level === "error") color = "\x1b[31m"; // Red

  return `${color}[${ts}] [${levelStr}] [${nsStr}] ${cleanMsg}${ctxStr}\x1b[0m`;
}

/**
 * Structured unified logging system.
 */
export const logger = {
  debug(ns: LogNamespace, msg: string, ctx?: LogContext): void {
    if (!isLogLevelEnabled("debug")) return;
    if (isTuiActive()) {
      appendToFile("debug", ns, msg, ctx);
    } else {
      // eslint-disable-next-line no-console
      console.log(formatConsole("debug", ns, msg, ctx));
    }
  },

  info(ns: LogNamespace, msg: string, ctx?: LogContext): void {
    if (!isLogLevelEnabled("info")) return;
    if (isTuiActive()) {
      appendToFile("info", ns, msg, ctx);
    } else {
      // eslint-disable-next-line no-console
      console.log(formatConsole("info", ns, msg, ctx));
    }
  },

  warn(ns: LogNamespace, msg: string, ctx?: LogContext): void {
    if (!isLogLevelEnabled("warn")) return;
    if (isTuiActive()) {
      appendToFile("warn", ns, msg, ctx);
    } else {
      // eslint-disable-next-line no-console
      console.warn(formatConsole("warn", ns, msg, ctx));
    }
  },

  error(ns: LogNamespace, msg: string, ctx?: LogContext): void {
    if (!isLogLevelEnabled("error")) return;
    if (isTuiActive()) {
      appendToFile("error", ns, msg, ctx);
    } else {
      // eslint-disable-next-line no-console
      console.error(formatConsole("error", ns, msg, ctx));
    }
  },
};
