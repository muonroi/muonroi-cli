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
 *
 * The `Authorization:` / `Bearer` patterns exist because an Error's `message`
 * (or a stack frame) can carry a credential verbatim — e.g. an HTTP client
 * error whose message embeds the request header it failed on. The
 * provider-key patterns above only catch OUR OWN key shapes (sk-/xai-/
 * AIzaSy...); a raw bearer token or an `Authorization:` header value has no
 * fixed prefix, so it is matched generically instead.
 *
 * ⚠️ EVERY replacement here MUST be safe to run over an already-JSON-encoded
 * string. Several sinks redact the SERIALIZED line (one regex pass over the
 * whole JSON) and are then parsed back — `readDecisionLog`, and every
 * `metadata_json` consumer. A value class that can swallow the closing `"` (or
 * a `\` escape) would turn a redaction into a corrupt row. So each value class
 * excludes `"`, `'` and `\`, and an opening quote is captured and re-emitted
 * rather than consumed.
 */
export function redactSecrets(str: string): string {
  return (
    str
      .replace(/\bsk-[A-Za-z0-9-_]{20,}\b/g, "[REDACTED_API_KEY]")
      .replace(/\bxai-[A-Za-z0-9-_]{20,}\b/g, "[REDACTED_API_KEY]")
      .replace(/\bAIzaSy[A-Za-z0-9-_]{30,}\b/g, "[REDACTED_API_KEY]")
      .replace(/\bAuthorization:\s*(?:Bearer\s+)?[A-Za-z0-9\-._~+/=]+/gi, "Authorization: [REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "Bearer [REDACTED]")
      // JWT triple-segment shape. OAuth access/refresh/id tokens are JWTs
      // (`src/providers/auth/token-store.ts` enrolls all three), and a bearer
      // token only carries its `Bearer ` prefix ON THE WIRE — once it is inside
      // an error message, an HTTP response body, or a decoded stderr line it
      // appears BARE, where the `Bearer` pattern above never sees it.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
      // `x-api-key` is Anthropic's header name — NOT `Authorization` — so the
      // header pattern above misses it completely, and the value only trips the
      // `sk-` pattern when the provider happens to use that prefix. The
      // optional quote makes this work on both `x-api-key: v` (plain stderr
      // text) and `"x-api-key":"v"` (a serialized JSON line).
      .replace(/\b(x-api-key"?\s*:\s*"?)[A-Za-z0-9\-._~+/=]+/gi, "$1[REDACTED]")
      // `api_key=value` / `--token=value` assignments — the shape a
      // MODEL-PROPOSED command takes (`export DEEPSEEK_API_KEY=…`,
      // `muonroi-cli --api-key=…`, an OAuth callback's `access_token=…`), which
      // the permission-mode audit persists verbatim into the decision log. The
      // NAME is deliberately kept so the diagnostic still says WHICH credential
      // the command touched.
      //
      // Case-INSENSITIVE and hyphen-tolerant on purpose. A proposed command uses
      // lowercase CLI flags (`--api-key=`, `--token=`) at least as often as an
      // uppercase env assignment, and `access_token=` is the standard URL/form
      // spelling — an uppercase-only class did not cover this pattern's OWN
      // stated threat. A leading `--` needs no special case: `-` is a non-word
      // character, so `\b` lands after it and the flag name stays readable.
      //
      // The count-field guard is STRUCTURAL, not case-based, so broadening the
      // case cannot weaken it: the `TOKEN` alternative must be followed by
      // `\s*=`, and every count field has an `S` in between, so `MAX_TOKENS=`,
      // `max_tokens=`, `--max-tokens=` and `prompt_cache_hit_tokens=` cannot
      // match at any position. Pinned in logger-secret-patterns.test.ts.
      //
      // The name prefix is bounded at 64 chars (env var and flag names are far
      // shorter). An unbounded `*` over this now-much-larger character class
      // would retry at every offset of a long base64 run — e.g. wire-debug's
      // 4000-char `responseBody` — making the pass quadratic for no benefit.
      //
      // `(?:Bearer\s+)?` is captured into group 1 rather than consumed as the
      // value, symmetric with the `Authorization:` pattern above. By the time
      // this runs, the `Bearer` pattern has already turned `token=Bearer <jwt>`
      // into `token=Bearer [REDACTED]`; without this the assignment pattern would
      // treat the literal word `Bearer` as the value and blank it too, yielding
      // `token=[REDACTED] [REDACTED]` and throwing away the marker that says
      // WHICH credential scheme was involved. Pinned by
      // interaction-log-error-serialization.test.ts.
      .replace(
        /\b([A-Za-z0-9_-]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*['"]?(?:Bearer\s+)?)[^\s"'\\]+/gi,
        "$1[REDACTED]",
      )
  );
}

// ── Error serialization ─────────────────────────────────────────────────────
//
// Root cause of the "logged error carries no message" defect: `message` and
// `stack` are non-enumerable on a real Error, so `JSON.stringify(new
// Error("x"))` is `"{}"`. Every logger call that passes `{ error: err }` (or
// nests an Error anywhere in its data) silently lost the cause once it hit
// appendToFile/formatConsole's JSON.stringify. Fixed once, here, so no
// individual call site needs to remember to extract `.message` by hand.

/** First N stack lines kept per Error — enough to locate the throw site without unbounded log growth. */
const MAX_ERROR_STACK_LINES = 5;
/** Bounds `cause` chains and `AggregateError.errors` so a cyclic or deep chain can't blow up the log line. */
const MAX_ERROR_CHAIN_DEPTH = 3;
/** Cap on how many `AggregateError.errors` entries are serialized. */
const MAX_AGGREGATE_ERRORS = 10;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string[];
  cause?: SerializedError | unknown;
  errors?: unknown[];
  [extraOwnProp: string]: unknown;
}

/**
 * Serializes an `Error` (including subclasses with extra own properties like
 * `code`/`status`, and `AggregateError`) into a plain object that survives
 * `JSON.stringify` intact. Bounded and never throws — a malformed `cause`
 * chain or `errors` array degrades gracefully rather than recursing forever.
 *
 * ⚠️ UNREDACTED. `message`, `stack`, and any extra own property are copied
 * VERBATIM — an auth error's message or an SDK error's `apiKey` property can
 * carry a real secret straight through. This is an internal building block
 * for {@link redactObject} (which redacts its output before returning it)
 * and for structural unit tests. Do NOT call this directly from anything
 * that persists its result (a log line, a DB row, a file) — call
 * {@link serializeErrorRedacted} instead, or pass the Error through
 * {@link redactObject}.
 */
export function serializeError(err: Error, depth = 0): SerializedError {
  const out: SerializedError = {
    name: err.name,
    message: err.message,
  };
  if (typeof err.stack === "string") {
    out.stack = err.stack.split("\n").slice(0, MAX_ERROR_STACK_LINES);
  }
  // Extra own enumerable properties a subclass attaches (e.g. `code`, `status`).
  for (const key of Object.keys(err)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    out[key] = (err as unknown as Record<string, unknown>)[key];
  }
  if (depth < MAX_ERROR_CHAIN_DEPTH) {
    const cause = (err as unknown as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      out.cause = serializeError(cause, depth + 1);
    } else if (cause !== undefined) {
      out.cause = cause;
    }
    const aggErrors = (err as unknown as { errors?: unknown }).errors;
    if (Array.isArray(aggErrors)) {
      out.errors = aggErrors
        .slice(0, MAX_AGGREGATE_ERRORS)
        .map((e) => (e instanceof Error ? serializeError(e, depth + 1) : e));
    }
  }
  return out;
}

/**
 * Recursively redacts sensitive fields from context objects. Any `Error`
 * found at any depth — top-level `{ error: err }` or nested inside another
 * object/array — is serialized via {@link serializeError} first, so
 * `message`/`stack` reach the written log line instead of `{}`. Cycles are
 * tracked via the current ancestor chain (not a global seen-set) so a value
 * referenced twice from different branches is not mistaken for a cycle.
 */
export function redactObject(obj: unknown, _ancestors: Set<object> = new Set()): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Error) {
    return redactObject(serializeError(obj), _ancestors);
  }
  if (typeof obj === "string") {
    return redactSecrets(obj);
  }
  if (Array.isArray(obj)) {
    if (_ancestors.has(obj)) return "[Circular]";
    _ancestors.add(obj);
    try {
      return obj.map((v) => redactObject(v, _ancestors));
    } finally {
      _ancestors.delete(obj);
    }
  }
  if (typeof obj === "object") {
    if (_ancestors.has(obj)) return "[Circular]";
    _ancestors.add(obj);
    try {
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
          res[k] = redactObject(v, _ancestors);
        }
      }
      return res;
    } finally {
      _ancestors.delete(obj);
    }
  }
  return obj;
}

/**
 * The ONE sanctioned way to persist an Error outside the logger's own
 * appendToFile/formatConsole path (e.g. `interaction_logs.metadata_json`,
 * `council-breadcrumbs.jsonl`). Structurally identical to {@link
 * serializeError}, but redacted the same way `logger.warn/error` redacts
 * its own data: `redactSecrets` runs over `message` and every stack line,
 * and any property whose KEY looks sensitive (`key`/`secret`/`token`/
 * `password`/`auth`, case-insensitive — e.g. an SDK error's `apiKey`
 * property) is replaced with `"[REDACTED]"` rather than copied verbatim.
 * Sinks that bypass the logger MUST call this (not {@link serializeError})
 * so a secret embedded in an error's message or own properties cannot reach
 * disk in plain text.
 */
export function serializeErrorRedacted(err: Error): SerializedError {
  return redactObject(serializeError(err)) as SerializedError;
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
