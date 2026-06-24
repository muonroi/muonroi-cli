/**
 * src/orchestrator/text-tool-call-detector.ts
 *
 * Detect when a model emitted a TOOL CALL as plain assistant TEXT instead of
 * using the real tool-calling interface. Some models (esp. cheap ones trained
 * on other agent harnesses — Cline / Roo / Continue dialects) write tool calls
 * as XML blocks like:
 *
 *     <read_file>
 *       <path>src/app/foo.ts</path>
 *     </read_file>
 *
 * The OpenAI-compatible layer never recognizes these as tool calls, so the SDK
 * reports finishReason="stop" with this XML as the final answer — the agentic
 * loop ends, the intended action never runs, and (live: storyflow_ui A/B,
 * deepseek-v4-flash session 905d564dbde4) the turn is silently wasted, often
 * leaving a half-finished edit behind. This detector lets the orchestrator
 * surface the failure instead of returning the broken text as a "final answer".
 *
 * Distinct from tool-args-repair.ts, which repairs the `arguments` JSON of a
 * tool call the SDK ALREADY recognized. Here there is NO recognized tool call.
 *
 * Precision is the priority — a false positive would wrongly flag a legitimate
 * final answer (e.g. documentation that quotes a tool block). The detector only
 * fires when a KNOWN tool-name tag appears as a structural invocation: an
 * opening tag immediately followed (whitespace/newlines allowed) by either a
 * known nested parameter tag or its own closing tag. A bare inline mention
 * ("use the <read_file> tool") never matches.
 */

// Tool-name tags from the common text-dialect agent harnesses (Cline, Roo,
// Continue, aider-ish) plus the generic wrappers. These are the OPENING tags a
// model emits when it tries to invoke a tool as text.
const TOOL_TAGS = [
  "read_file",
  "write_to_file",
  "write_file",
  "edit_file",
  "apply_diff",
  "replace_in_file",
  "search_and_replace",
  "insert_content",
  "search_files",
  "list_files",
  "list_code_definition_names",
  "execute_command",
  "run_command",
  "browser_action",
  "use_mcp_tool",
  "access_mcp_resource",
  "ask_followup_question",
  "attempt_completion",
  // muonroi builtin tool names the NON_ANTHROPIC_TOOL_PREAMBLE explicitly
  // forbids as text. Live: deepseek emitted `<bash>find …</bash>` as text at
  // turn end (session ab/ds-final) — `bash` was missing here so it slipped the
  // detector → no re-steer. Match only with a close tag or nested param,
  // never a bare mention.
  "bash",
  "grep",
  "glob",
  "read_multiple_files",
  "delegate",
  "task",
] as const;

// Nested parameter tags that legitimately appear INSIDE a text-dialect tool
// block. An opening tool tag followed shortly by one of these is a strong
// signal of an actual (mis-formatted) invocation rather than a prose mention.
const PARAM_TAGS = [
  "path",
  "content",
  "command",
  "diff",
  "args",
  "query",
  "regex",
  "file_path",
  "search",
  "replace",
  "line",
  "operations",
  "question",
  "result",
  "recursive",
  "uri",
  "server_name",
  "tool_name",
  "arguments",
];

const PARAM_ALTERNATION = PARAM_TAGS.join("|");

// Generic tool-call wrappers used by other native formats. `<invoke name="...">`
// is the Anthropic XML style; `<tool_call>` / `<function_calls>` are Qwen/other.
// These are matched directly (the wrapper itself is the signal).
const GENERIC_WRAPPER_RE =
  /<\/?(?:tool_call|function_calls|tool_use)\b|<invoke\b[^>]*\bname\s*=|<function\b[^>]*\bname\s*=/i;

// DeepSeek native tool-call markup leaking into text content. Signature is a
// vertical-bar sentinel — either U+FF5C fullwidth `｜` or U+2502 box-drawing `│`
// — wrapping invoke/tool_calls/parameter tokens, e.g.:
//   Old format:  <｜invoke name="read_file">   (U+FF5C, single bar)
//   New format:  <│ DSML │invoke name="…">   (U+2502, with optional DSML label)
// Live: storyflow_ui explore-A/B, deepseek T3 (session 799f0508e830) emitted a
// full DSML invoke block as text and made no real tool call → empty, silent turn.
// The generic `<invoke` matcher misses it because `<` is followed by the sentinel.
// Updated 2026-06-24 to cover both U+2502 and U+FF5C (tests use U+2502).
const DSML_BAR = "[│｜]+"; // matches U+2502 (box-drawing) and U+FF5C (fullwidth)
const DSML_WRAPPER_RE = new RegExp(`${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?(?:invoke|tool_calls?|parameter)\\b`, "i");
const DSML_INVOKE_NAME_RE = new RegExp(`${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"`, "i");

/** Build a per-tool detector: `<tool>` then (within a small gap) a `<param>` or `</tool>`. */
function buildToolRegexes(): RegExp[] {
  return TOOL_TAGS.map(
    (tag) =>
      // <tag ...> [up to ~400 chars of whitespace/attrs/text] then <param> or </tag>
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]{0,400}?(?:<(?:${PARAM_ALTERNATION})\\b[^>]*>|</${tag}>)`, "i"),
  );
}

const TOOL_REGEXES = buildToolRegexes();

export interface TextToolCallDetection {
  detected: boolean;
  /** The first matched tool/wrapper name, for telemetry. Null when not detected. */
  tool: string | null;
}

/**
 * Detect a tool call emitted as plain text. Returns the first matching tool
 * name (or generic wrapper label) for telemetry. High precision: requires a
 * structural invocation shape, not a bare tag mention.
 */
export function detectTextEmittedToolCall(text: string): TextToolCallDetection {
  if (!text || text.length === 0) return { detected: false, tool: null };
  // Cap the scan — pathological inputs shouldn't cost more than a glance.
  const scan = text.length > 200_000 ? text.slice(0, 200_000) : text;

  if (DSML_WRAPPER_RE.test(scan)) {
    const nameMatch = scan.match(DSML_INVOKE_NAME_RE);
    return { detected: true, tool: nameMatch ? nameMatch[1]! : "dsml" };
  }

  if (GENERIC_WRAPPER_RE.test(scan)) {
    const m = scan.match(GENERIC_WRAPPER_RE);
    return { detected: true, tool: m ? normalizeWrapperName(m[0]) : "tool_call" };
  }

  for (let i = 0; i < TOOL_REGEXES.length; i++) {
    if (TOOL_REGEXES[i]!.test(scan)) {
      return { detected: true, tool: TOOL_TAGS[i]! };
    }
  }
  return { detected: false, tool: null };
}

function normalizeWrapperName(raw: string): string {
  const m = raw.match(/tool_call|function_calls|tool_use|invoke|function/i);
  return m ? m[0].toLowerCase() : "tool_call";
}

/**
 * Parse the DeepSeek-native DSML tool-call markup into a structured list so the
 * re-steer can restate the model's EXACT intent (much more effective than a
 * generic "use the tool interface" nudge). Pure — no execution. Recognizes:
 *   Old format:  <│invoke name="read_file">
 *                  <│parameter name="file_path" string="true">src/app/foo.ts</│parameter>
 *                </│invoke>
 *   New format:  <│ DSML │invoke name="read_file">
 *                  <│ DSML │parameter name="file_path" string="true">src/app/foo.ts</│ DSML │parameter>
 *                </│ DSML │invoke>
 * Both U+2502 (box-drawing │) and U+FF5C (fullwidth ｜) bars are recognized.
 * Returns one entry per invoke block; args preserve insertion order. Tolerant of
 * missing close tags (cheap models truncate). Returns [] when no parseable invoke
 * block exists.
 */
export interface ParsedDsmlCall {
  name: string;
  args: Record<string, string>;
}

// Guard regex: at least one DSML-bar sentinel must exist before we bother scanning
const DSML_GUARD_RE = /[│｜]/;
const DSML_INVOKE_BLOCK_RE = new RegExp(
  `${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"([\\s\\S]*?)(?=${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?invoke\\s|$)`,
  "gi",
);
const DSML_PARAM_RE = new RegExp(
  `${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/?${DSML_BAR}\\s*(?:DSML\\s*${DSML_BAR}\\s*)?parameter`,
  "gi",
);

export function parseDsmlToolCalls(text: string): ParsedDsmlCall[] {
  if (!text || !DSML_GUARD_RE.test(text)) return [];
  const calls: ParsedDsmlCall[] = [];
  DSML_INVOKE_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
  while ((block = DSML_INVOKE_BLOCK_RE.exec(text)) !== null) {
    const name = block[1]!;
    const body = block[2] ?? "";
    const args: Record<string, string> = {};
    DSML_PARAM_RE.lastIndex = 0;
    let p: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
    while ((p = DSML_PARAM_RE.exec(body)) !== null) {
      args[p[1]!] = (p[2] ?? "").trim();
    }
    calls.push({ name, args });
  }
  return calls;
}

export const _internals = { TOOL_TAGS, PARAM_TAGS, GENERIC_WRAPPER_RE };
