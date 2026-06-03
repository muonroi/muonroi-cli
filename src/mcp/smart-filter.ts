/**
 * Smart MCP server filtering.
 *
 * MCP tool schemas are the single largest variable contributor to per-turn
 * input tokens — a live probe ("Reply with one word: PONG", session
 * 8a87aa060c6a) carried 53 tool schemas (~21K input tokens) for a turn that
 * used zero tools. ~36 of those came from MCP servers that the turn could not
 * possibly need.
 *
 * The original inline filter (message-processor.ts) only skipped browser/vision
 * servers when the message had no browser signal. This generalises that same
 * proven pattern to a small category→signal table: an OPTIONAL category is
 * dropped only when its signal is absent from the user's current message.
 *
 * Safety: builtin tools are never touched here, and only servers whose id
 * matches a known optional category are ever dropped — domain servers
 * (filesystem, muonroi-tools, harness, …) always pass through. A false
 * positive (signal matched when not strictly needed) merely keeps a server,
 * costing tokens but never breaking capability; the regexes are deliberately
 * broad so the failure mode is "kept", not "wrongly dropped".
 *
 * Disable entirely with MUONROI_DISABLE_SMART_MCP=1 (handled by the caller,
 * passed in as `disabled`).
 */

/** Browser/vision automation servers — only needed when the turn touches a page. */
const SKIP_WHEN_NO_BROWSER = /playwright|chrome|browser|devtools|vision|figma|canva/i;

/** External lookup servers (docs / web fetch) — only needed for external info. */
const SKIP_WHEN_NO_DOCS = /context7|(^|[-_])fetch([-_]|$)|docs/i;

/** Matches a browser/page-automation intent (kept identical to the legacy inline regex, plus a URL). */
function hasBrowserSignal(message: string): boolean {
  return (
    /https?:\/\/\S+/i.test(message) ||
    /\b(screenshot|browser|playwright|chrome|figma|canva|render|webpage|website|url|hyperlink|navigate|click|scrape)\b/i.test(
      message,
    )
  );
}

/** Matches an external-information intent (docs lookup / web fetch). Broad on purpose. */
function hasDocsSignal(message: string): boolean {
  return (
    /https?:\/\/\S+/i.test(message) ||
    /\b(docs?|documentation|api|sdk|library|libraries|framework|package|npm|pip|cargo|crate|gem|maven|nuget|install|migrat\w*|changelog|release\s*notes?|reference|usage|fetch|download|http|web|google|search\s+(the\s+)?web)\b/i.test(
      message,
    )
  );
}

export interface SmartFilterOptions {
  /** When true, smart filtering is bypassed and every server passes through. */
  disabled?: boolean;
}

/**
 * Filter a list of MCP servers down to those plausibly relevant to the user's
 * current message. Only `.id` is read; the generic keeps the caller's concrete
 * server type intact.
 */
export function filterMcpServersByMessage<T extends { id: string }>(
  servers: T[],
  userMessage: string,
  opts: SmartFilterOptions = {},
): T[] {
  if (opts.disabled) return servers;
  const browser = hasBrowserSignal(userMessage);
  const docs = hasDocsSignal(userMessage);
  return servers.filter((s) => {
    if (!browser && SKIP_WHEN_NO_BROWSER.test(s.id)) return false;
    if (!docs && SKIP_WHEN_NO_DOCS.test(s.id)) return false;
    return true;
  });
}
