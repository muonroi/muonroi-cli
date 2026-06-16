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

/**
 * External-lookup servers (docs / URL fetch / web search) — only needed when
 * the turn reaches for information outside the codebase. Web-search servers
 * (tavily/exa/brave/serper/perplexity/…) belong to the same category: a pure
 * code-edit turn never needs them, and each carries 2-3 tool schemas.
 */
const SKIP_WHEN_NO_DOCS =
  /context7|(^|[-_])fetch([-_]|$)|docs|tavily|exa|brave|serper|perplexity|web[-_]?search|websearch/i;

/** Matches a browser/page-automation intent (kept identical to the legacy inline regex, plus a URL). */
function hasBrowserSignal(message: string): boolean {
  return (
    /https?:\/\/\S+/i.test(message) ||
    /\b(screenshot|browser|playwright|chrome|figma|canva|render|webpage|website|url|hyperlink|navigate|click|scrape)\b/i.test(
      message,
    )
  );
}

/**
 * Matches an external-information intent (docs lookup / URL fetch / web search).
 * Broad on purpose — bias is keep-not-drop. Web-search intent adds a few
 * low-collision terms (news/weather/online/internet/"look up") that rarely
 * appear in a pure code-edit prompt; bare "search" is intentionally excluded
 * because it collides with "search the codebase" / "add a search feature".
 */
function hasDocsSignal(message: string): boolean {
  return (
    /https?:\/\/\S+/i.test(message) ||
    /\b(docs?|documentation|api|sdk|library|libraries|framework|package|npm|pip|cargo|crate|gem|maven|nuget|install|migrat\w*|changelog|release\s*notes?|reference|usage|fetch|download|http|web|google|search\s+(the\s+)?web|news|weather|headlines|look\s*up|online|internet)\b/i.test(
      message,
    )
  );
}

/**
 * Matches a question ABOUT the Muonroi ecosystem — where muonroi-docs (the
 * authoritative ecosystem source: BB/.NET recipes, package docs, open-core
 * boundary) is exactly what's needed, even though the message carries no generic
 * docs/api keyword. Deliberately ecosystem-specific so it only ever KEEPS
 * muonroi-docs (never other docs servers). EN + VI.
 */
function hasEcosystemSignal(message: string): boolean {
  return /\bmuonroi\b|\becosystem\b|hệ\s*sinh\s*thái|he\s*sinh\s*thai|building[-\s]?block|\bbb\b|open[-\s]?core/i.test(
    message,
  );
}

/**
 * Explicit "use a tool / MCP tool" intent. The filter only sees server *ids*,
 * not their tool lists (MCP tools are fetched lazily at build time), so when the
 * user asks to call a specific tool by name we cannot tell which server owns it.
 * Dropping any optional server then risks stripping the exact tool requested.
 *
 * Live miss (session f6f7881a5fae): "bạn thử call tool setup_guide ... ( call
 * tool chứ không phải đọc code )" carried no docs keyword, so `muonroi-docs`
 * (id matches /docs/) was dropped — the model had no `setup_guide` tool and
 * resorted to driving the server by hand over bash JSON-RPC, fabricating output.
 *
 * When this fires we keep ALL optional servers for the turn. Over-keeping costs
 * tokens but never removes capability — this module's documented safe direction.
 * EN + VI: "call/use/invoke/run the X tool", "tool call", "gọi/dùng/chạy tool".
 */
function hasExplicitToolIntent(message: string): boolean {
  return (
    /\b(?:call|use|invoke|run|exercise|trigger|try)\s+(?:the\s+)?(?:mcp\s+)?(?:[a-z0-9_.-]+\s+)?tool(?:s)?\b/i.test(
      message,
    ) ||
    /\btool[\s_-]?call\b/i.test(message) ||
    /\bmcp\b[^\n]*\btool/i.test(message) ||
    /\b(?:gọi|dùng|chạy|thử)\s+(?:tool|mcp)\b/i.test(message)
  );
}

/**
 * Filesystem-MCP tool names that 1:1 duplicate a first-class BUILTIN file tool.
 * The builtin `read_file`/`write_file`/`edit_file` are strictly better (read-
 * before-write tracking, LSP sync, CRLF-tolerant matching, per-turn dedup +
 * read-budget wrappers), so exposing the MCP twins on top is pure redundancy.
 *
 * Live waste (storyflow_ui explore-flow A/B, grok session f5dfab0ce0ca): the
 * model re-read the SAME three files via BOTH `read_file` and
 * `mcp_filesystem__read_text_file` — a 772-line component was read 6× — because
 * two interchangeable read tools were on offer. Each re-read re-injects the
 * whole file into context (large input-token leak) on top of ~150 tok/schema.
 *
 * Mapping: bare MCP tool name → the builtin that already covers it. We only drop
 * the MCP tool when that builtin is actually present in the turn's tool set.
 */
const FS_MCP_BUILTIN_EQUIVALENT: Record<string, string> = {
  read_file: "read_file",
  read_text_file: "read_file",
  read_media_file: "read_file",
  read_multiple_files: "read_file",
  write_file: "write_file",
  edit_file: "edit_file",
};

/**
 * Drop filesystem-MCP read/write/edit tools that duplicate a present builtin.
 * Scoped to the `mcp_filesystem__` prefix so non-filesystem MCP tools (and the
 * filesystem server's NON-duplicate tools — directory_tree, search_files,
 * get_file_info, …) are never touched. Returns the filtered set plus the list
 * of dropped names so the caller can log it (no silent capability removal).
 * Override with MUONROI_KEEP_REDUNDANT_FS_MCP=1.
 */
export function dropRedundantFsMcpTools<T extends Record<string, unknown>>(
  mcpTools: T,
  builtinToolNames: ReadonlySet<string>,
): { tools: T; dropped: string[] } {
  if (process.env.MUONROI_KEEP_REDUNDANT_FS_MCP === "1") return { tools: mcpTools, dropped: [] };
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, tool] of Object.entries(mcpTools)) {
    const m = name.match(/^mcp_filesystem__(.+)$/);
    const equivalent = m ? FS_MCP_BUILTIN_EQUIVALENT[m[1]!] : undefined;
    if (equivalent && builtinToolNames.has(equivalent)) {
      dropped.push(name);
      continue;
    }
    out[name] = tool;
  }
  return { tools: out as T, dropped };
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
  // Explicit "call the X tool" intent → keep every server this turn. We can't map
  // a named tool back to its server from config alone (tool lists load lazily),
  // so dropping any optional server risks stripping the exact tool requested.
  if (hasExplicitToolIntent(userMessage)) return servers;
  const browser = hasBrowserSignal(userMessage);
  const docs = hasDocsSignal(userMessage);
  const ecosystem = hasEcosystemSignal(userMessage);
  const lower = userMessage.toLowerCase();
  return servers.filter((s) => {
    // A server named outright in the message ("check the muonroi-docs MCP") is
    // always relevant — never let a category skip override an explicit mention.
    if (s.id && lower.includes(s.id.toLowerCase())) return true;
    // muonroi-docs is the AUTHORITATIVE ecosystem source. A question about the
    // Muonroi ecosystem ("hệ sinh thái muonroi", "building-block", "bb rule
    // engine") matches no generic docs/api keyword, so SKIP_WHEN_NO_DOCS would
    // wrongly drop it and the agent falls back to guessing from files (live
    // session dbe408937a3d turn 1). Keep it whenever the turn is ecosystem-about.
    if (ecosystem && /(^|[-_])docs([-_]|$)/.test(s.id) && /muonroi/i.test(s.id)) return true;
    if (!browser && SKIP_WHEN_NO_BROWSER.test(s.id)) return false;
    if (!docs && SKIP_WHEN_NO_DOCS.test(s.id)) return false;
    return true;
  });
}
