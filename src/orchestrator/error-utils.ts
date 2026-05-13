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

export function humanizeApiError(error: unknown): string {
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

export { extractResponseDetail, STATUS_MESSAGES };
