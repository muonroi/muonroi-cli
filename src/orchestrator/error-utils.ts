import { APICallError } from "@ai-sdk/provider";

const STATUS_MESSAGES: Record<number, string> = {
  400: "The request was invalid. This may be caused by an unsupported parameter or model.",
  401: "Authentication failed. Your API key may be invalid or expired.",
  403: "Access denied. Your API key does not have permission for this request.",
  404: "The requested model or endpoint was not found. Check your model name and base URL.",
  408: "The request timed out. Please try again.",
  422: "The request could not be processed. Check your message format or parameters.",
  429: "Rate limit exceeded. Please wait a moment and try again.",
  500: "The API server encountered an internal error. Please try again later.",
  502: "The API server is temporarily unavailable. Please try again later.",
  503: "The API service is temporarily overloaded. Please try again later.",
  529: "The API service is overloaded. Please try again later.",
};

export function isContextLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(context|token|prompt).*(limit|length|large|window|overflow)|too many tokens|maximum context/i.test(message);
}

export function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api[_ ]?key|token|credential)|authentication failed|forbidden|access denied/i.test(
    message,
  );
}

export function isMalformedFunctionNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Expected ['"]function\.name['"] to be a string/i.test(message);
}

/** Routing context for humanizeApiError — the model/provider that actually ran. */
export interface ApiErrorContext {
  modelId?: string;
  providerId?: string;
}

/** Statuses where the model/provider CHOICE is the lever, so naming it helps. */
const ROUTING_STATUSES = new Set([401, 402, 403, 429]);

function getStatusCode(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode ?? undefined;
  const e = error as { statusCode?: number; status?: number } | null;
  return e?.statusCode ?? e?.status;
}

/**
 * For account/auth/rate errors, append the routed model + provider and a
 * targeted fix hint. Reveals e.g. a project-pinned deepseek model overriding
 * the user's default (the "402 Insufficient Balance" mystery) and points at the
 * lever (`-m`, `keys login`, top-up). Returns "" for non-routing errors so a
 * server-side 5xx isn't mislabeled as the user's routing problem.
 */
function routingSuffix(error: unknown, ctx: ApiErrorContext | undefined): string {
  if (!ctx?.modelId) return "";
  const message = error instanceof Error ? error.message : String(error);
  let status = getStatusCode(error);
  // Some gateways surface a balance error without a clean statusCode.
  if (status === undefined && /insufficient balance|out of (balance|credit)/i.test(message)) {
    status = 402;
  }
  if (status === undefined || !ROUTING_STATUSES.has(status)) return "";

  const where = `routed to model "${ctx.modelId}"${ctx.providerId ? ` via provider "${ctx.providerId}"` : ""}`;
  const hint =
    status === 402
      ? "out of balance/credit — top up the provider account, or switch model with `-m <model>`."
      : status === 401 || status === 403
        ? "not authenticated for this provider — run `keys login <provider>` (or set its API key), or switch model with `-m <model>`."
        : "rate-limited — wait and retry, or switch model with `-m <model>`.";
  return ` [${where}] — ${hint}`;
}

export function humanizeApiError(error: unknown, ctx?: ApiErrorContext): string {
  return `${humanizeApiErrorBase(error)}${routingSuffix(error, ctx)}`;
}

function humanizeApiErrorBase(error: unknown): string {
  if (isMalformedFunctionNameError(error)) {
    return "Model emitted a malformed tool call (function.name missing). Skipping this turn — please retry or rephrase.";
  }

  if (APICallError.isInstance(error)) {
    const detail = extractResponseDetail(error.responseBody);
    if (detail) return detail;
    if (error.statusCode && STATUS_MESSAGES[error.statusCode]) {
      return STATUS_MESSAGES[error.statusCode];
    }
  }

  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(/^AI_\w+Error:\s*/i, "").trim() || raw;
  if (/NoSuchTool|no such tool/i.test(raw)) {
    const toolMatch = raw.match(/Tool\s+"?(\w+)"?\s+(?:is\s+)?not\s+found/i) ?? raw.match(/tool\s+(\w+)/i);
    const toolName = toolMatch?.[1] ?? "that tool";
    if (toolName === "search_web") {
      return `"search_web" is not available. Use bash with curl for web requests, or delegate to an explore agent for research.`;
    }
    return `Tool "${toolName}" is not available. Check the TOOLS list in the system prompt for supported tools.`;
  }
  return stripped;
}

function extractResponseDetail(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Forensics envelope for opaque provider 4xx errors. SiliconFlow / DeepSeek
 * routinely return "The parameter is invalid. Please check again." with no
 * indication of WHICH parameter — sessions hit by that string in
 * interaction_logs leave no actionable trace because we only persisted the
 * friendly message. This helper extracts the wire-level shape from an
 * APICallError so logInteraction can persist enough info to diagnose without
 * needing a repro.
 *
 * Body and headers are truncated/redacted. Request body is reduced to the
 * top-level parameter names — values may contain secrets or PII and must
 * NEVER be persisted.
 */
export interface ApiErrorForensics {
  statusCode: number | undefined;
  urlHost: string | undefined;
  responseBodyTrunc: string | undefined;
  requestParamKeys: string[] | undefined;
  isRetryable: boolean | undefined;
}

const RESPONSE_BODY_CAP = 1000;

export function summarizeApiErrorForLog(error: unknown): ApiErrorForensics | null {
  if (!APICallError.isInstance(error)) return null;
  let urlHost: string | undefined;
  try {
    urlHost = new URL(error.url).host;
  } catch {
    urlHost = undefined;
  }
  let requestParamKeys: string[] | undefined;
  if (error.requestBodyValues && typeof error.requestBodyValues === "object") {
    requestParamKeys = Object.keys(error.requestBodyValues as Record<string, unknown>).sort();
  }
  const body = typeof error.responseBody === "string" ? error.responseBody : undefined;
  const responseBodyTrunc =
    body && body.length > RESPONSE_BODY_CAP ? `${body.slice(0, RESPONSE_BODY_CAP)}…[truncated]` : body;
  return {
    statusCode: error.statusCode,
    urlHost,
    responseBodyTrunc,
    requestParamKeys,
    isRetryable: error.isRetryable,
  };
}

export { extractResponseDetail, STATUS_MESSAGES };
