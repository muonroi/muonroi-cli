import { APICallError } from "@ai-sdk/provider";

const STATUS_MESSAGES: Record<number, string> = {
  400: "The provider rejected this request as invalid — usually a parameter or model it doesn't support. Try switching models with `-m <model>`, or simplify the request and retry.",
  401: "The provider didn't accept your API key — it may be missing, invalid, or expired. Run `keys login <provider>` to set a fresh key, then try again.",
  403: "Your API key works, but it isn't allowed to make this request. Check your plan or key permissions on the provider's dashboard, or switch models with `-m <model>`.",
  404: "The provider couldn't find that model or endpoint. Double-check the model name (see `models list`) and your base URL, then try again.",
  408: "The request took too long and timed out. This is usually temporary — just try again.",
  422: "The provider understood the request but couldn't process it. Check your message format and parameters, then retry — switching models with `-m <model>` can also help.",
  429: "You're sending requests faster than the provider allows right now. Wait a moment and try again, or switch to another model with `-m <model>`.",
  500: "Something went wrong on the provider's servers — not on your end. Give it a moment and try again later.",
  502: "The provider's servers are temporarily unreachable. This usually clears up on its own — try again in a minute.",
  503: "The provider is overloaded right now. Give it a minute and retry, or switch models with `-m <model>` in the meantime.",
  529: "The provider is overloaded right now. Give it a minute and retry, or switch models with `-m <model>` in the meantime.",
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
  const rawMsg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const isConsoleGo = rawMsg.includes("console go") || ctx?.providerId === "opencode-go";
  const isRateLimitMsg = /rate limit|rate-limited|429|too many requests/i.test(rawMsg);

  // If we have model context and it's a routing error (by status or by message content)
  if (!ctx?.modelId) return "";
  if (!(status !== undefined && ROUTING_STATUSES.has(status)) && !isRateLimitMsg && !isConsoleGo) return "";

  const where = `routed to model "${ctx.modelId}"${ctx.providerId ? ` via provider "${ctx.providerId}"` : ""}`;

  // A generic "invalid request" rejection — NOT a rate limit. Console Go can
  // silently re-route (e.g. deepseek-v4-flash → a kimi coding backend) and then
  // reject a long tool-loop payload with a bare 400 invalid_request. Retrying
  // as-is never helps (isRetryable:false), so the hint must NOT say "wait and
  // retry" — it must point at the real levers (switch model / shorten payload).
  const isInvalidRequest = status === 400 || status === 422;

  let hint: string;
  if (isConsoleGo && (isRateLimitMsg || status === 429)) {
    hint =
      "the Console Go proxy hit its own burst rate limit — this is separate from your web 'Rolling Usage' %, so the dashboard can look fine while the proxy still throttles. Wait a moment, use native DeepSeek with `-m deepseek-v4-flash`, or switch provider.";
  } else if (status === 402) {
    hint =
      "this provider account is out of balance or credit. Top it up on the provider's site, or switch to another model with `-m <model>`.";
  } else if (status === 401 || status === 403) {
    hint =
      "you're not authenticated for this provider. Run `keys login <provider>` (or set its API key), or switch to another model with `-m <model>`.";
  } else if (isInvalidRequest) {
    hint =
      "the provider rejected this request as invalid — often a param or backend model it doesn't support, or a tool-loop payload the routed model can't accept (some gateways re-route to a different backend than the one you picked). Switch models with `-m <model>` or shorten/simplify the request; retrying it unchanged won't help.";
  } else if (isRateLimitMsg || status === 429) {
    hint = "the provider is rate-limiting you. Wait a moment and retry, or switch to another model with `-m <model>`.";
  } else {
    hint =
      "the routed model or provider couldn't complete this request. Switch to another model with `-m <model>`, or try again.";
  }
  return ` [${where}] — ${hint}`;
}

export function humanizeApiError(error: unknown, ctx?: ApiErrorContext): string {
  return `${humanizeApiErrorBase(error)}${routingSuffix(error, ctx)}`;
}

function humanizeApiErrorBase(error: unknown): string {
  if (isMalformedFunctionNameError(error)) {
    return "The model produced a malformed tool call (its function name was missing), so this turn was skipped. Just send your request again — rephrasing slightly often helps.";
  }

  if (APICallError.isInstance(error)) {
    const detail = extractResponseDetail(error.responseBody);
    const status = error.statusCode;
    // 5xx response bodies are usually generic server-side noise that MASKS the
    // actionable status. Verified live: SiliconFlow returns a 500 with body
    // {code:60000,message:"Request failed: Unknown error."} — surfacing that
    // string told the user nothing and hid the fact it was a retryable 500.
    // For 5xx prefer the canned "retry later" message + the status code; keep a
    // body detail only when it actually adds information.
    if (status && status >= 500) {
      const canned =
        STATUS_MESSAGES[status] ??
        "The provider's servers returned an error — not something you did. Wait a bit and try again.";
      if (!detail || isOpaqueDetail(detail)) return `${canned} (HTTP ${status})`;
      return `${detail} (HTTP ${status})`;
    }
    // 4xx: the body almost always says WHAT was wrong — keep it verbatim.
    if (detail) return detail;
    if (status && STATUS_MESSAGES[status]) {
      return STATUS_MESSAGES[status];
    }
  }

  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(/^AI_\w+Error:\s*/i, "").trim() || raw;
  if (/NoSuchTool|no such tool/i.test(raw)) {
    const toolMatch = raw.match(/Tool\s+"?(\w+)"?\s+(?:is\s+)?not\s+found/i) ?? raw.match(/tool\s+(\w+)/i);
    const toolName = toolMatch?.[1] ?? "that tool";
    if (toolName === "search_web") {
      return `"search_web" isn't available here. For web requests, use bash with curl instead, or hand the research off to an explore agent.`;
    }
    return `Tool "${toolName}" isn't available in this session. Check the TOOLS list in the system prompt to see which tools you can use.`;
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
 * A provider "detail" string that carries no diagnostic value — generic
 * server-error phrasing that masks the more useful HTTP status. Verified live:
 * SiliconFlow 500s carry message "Request failed: Unknown error.". Used only on
 * the 5xx path so an informative server message is still preferred when present.
 */
function isOpaqueDetail(detail: string): boolean {
  const s = detail.trim().toLowerCase();
  return (
    s.length < 4 ||
    /unknown error|request failed|internal server error|service (unavailable|temporarily)|bad gateway|gateway time-?out|^error\.?$|^failed\.?$/.test(
      s,
    )
  );
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
  /** Field-key signature per distinct assistant message shape (PII-safe).
   * Diagnoses Z.ai 1210 / SiliconFlow 20015 "invalid parameter" rejections
   * where the culprit is a missing/extra field on assistant turns in a
   * multi-step tool loop (e.g. reasoning_content present on some turns but
   * absent on tool-only turns). */
  assistantFieldKeys: string[] | undefined;
  /** Per-assistant-message char counts (PII-safe — lengths only, no text).
   * Distinguishes the "uniform shape but still rejected" failure mode:
   * H1 cumulative reasoning budget exceeded vs H2 empty reasoning_content
   * string vs H3 oversized text/tool payload. Set when messages are present. */
  assistantReasoningLens: number[] | undefined;
  /** Total reasoning_content chars across assistant messages. */
  totalReasoningChars: number | undefined;
  /** Values of scalar SDK-config params (reasoning_effort, verbosity,
   * tool_choice, response_format, max_tokens, temperature, top_p,
   * frequency_penalty, presence_penalty, seed, stop, parallel_tool_calls).
   * PII-safe (generation config, not prompt content) — pinpoints WHICH
   * param value a provider rejects when the error is generic (Z.ai 1210,
   * SiliconFlow 20015). */
  configParamValues: Record<string, unknown> | undefined;
  /** Per-assistant tool_calls counts (from assistant messages in the request
   * that failed). Captures H3 for Z.ai 1210: a single assistant response
   * emitting many parallel tool_calls (e.g. 8 or 12) → the follow-up request
   * carrying that many role:tool results gets rejected by the coding endpoint
   * with generic 1210. */
  assistantToolCallCounts: number[] | undefined;
  /** Count of role:"tool" messages in the failing request body. Complements
   * assistantToolCallCounts to show the round-trip payload size for H3. */
  toolMessageCount: number | undefined;
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
  const bodyValues =
    error.requestBodyValues && typeof error.requestBodyValues === "object"
      ? (error.requestBodyValues as { messages?: unknown; [k: string]: unknown })
      : undefined;
  const requestParamKeys = bodyValues ? Object.keys(bodyValues).sort() : undefined;
  // Collect the distinct field-key signature across assistant wire messages.
  // Only key NAMES are persisted — values may contain secrets/PII.
  let assistantFieldKeys: string[] | undefined;
  let assistantReasoningLens: number[] | undefined;
  let assistantToolCallCounts: number[] | undefined;
  let totalReasoningChars = 0;
  let toolMessageCount = 0;
  if (bodyValues && Array.isArray(bodyValues.messages)) {
    const signatures = new Set<string>();
    const rcLens: number[] = [];
    const tcLens: number[] = [];
    for (const m of bodyValues.messages) {
      const msg = m as Record<string, unknown> | null;
      if (msg?.role === "tool") {
        toolMessageCount++;
        continue;
      }
      if (msg?.role !== "assistant") continue;
      const sig = Object.keys(msg ?? {})
        .sort()
        .join(",");
      signatures.add(sig);
      const rc = msg?.reasoning_content;
      if (typeof rc === "string") {
        rcLens.push(rc.length);
        totalReasoningChars += rc.length;
      } else {
        rcLens.push(-1); // marker: reasoning_content missing/non-string on this turn
      }
      const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
      tcLens.push(tcs);
    }
    if (signatures.size > 0) assistantFieldKeys = [...signatures].sort();
    if (rcLens.length > 0) assistantReasoningLens = rcLens;
    if (tcLens.length > 0) assistantToolCallCounts = tcLens;
  }
  const body = typeof error.responseBody === "string" ? error.responseBody : undefined;
  const responseBodyTrunc =
    body && body.length > RESPONSE_BODY_CAP ? `${body.slice(0, RESPONSE_BODY_CAP)}…[truncated]` : body;
  return {
    statusCode: error.statusCode,
    urlHost,
    responseBodyTrunc,
    requestParamKeys,
    assistantFieldKeys,
    assistantReasoningLens,
    totalReasoningChars: assistantReasoningLens ? totalReasoningChars : undefined,
    configParamValues: bodyValues ? extractConfigParamValues(bodyValues) : undefined,
    assistantToolCallCounts,
    toolMessageCount: bodyValues && Array.isArray(bodyValues.messages) ? toolMessageCount : undefined,
    isRetryable: error.isRetryable,
  };
}

/**
 * Scalar SDK-config params whose VALUES are PII-safe (generation config, not
 * user prompt content). See `ApiErrorForensics.configParamValues`.
 * Includes parallel_tool_calls because Z.ai GLM coding endpoint rejects
 * high-parallelism tool call batches (observed 8-12 in one assistant turn)
 * with generic 1210; capturing the value helps confirm if SDK overrode it.
 */
const CONFIG_PARAM_KEYS = [
  "reasoning_effort",
  "verbosity",
  "tool_choice",
  "response_format",
  "max_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "parallel_tool_calls",
] as const;

function extractConfigParamValues(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_PARAM_KEYS) {
    if (k in body) out[k] = body[k] ?? null;
  }
  return out;
}

export { extractResponseDetail, STATUS_MESSAGES };
