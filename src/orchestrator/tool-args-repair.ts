/**
 * src/orchestrator/tool-args-repair.ts
 *
 * Conservative repair for malformed tool-call argument strings emitted by
 * models whose tokenization breaks structured JSON. Two distinct Qwen3-30B
 * defects observed in sessions 080fe2fcbf24 and 11bb9218f605 (2026-05-26):
 *
 *   1. Native-format leak — Qwen's `<tool_call>...</tool_call>` tags and
 *      extra trailing `}` leak into the OpenAI-compatible `arguments`
 *      string field:
 *         {"pattern": "..."}}
 *         </tool_call>
 *
 *   2. Missing close-quote — when a string value ends with an escape
 *      sequence like `\\}` (regex), the model drops the closing `"`:
 *         {"pattern": "catch\\s*\\{\\s*\\}, "path": "src", ...}
 *      Intended:
 *         {"pattern": "catch\\s*\\{\\s*\\}", "path": "src", ...}
 *
 * The repair function is intentionally narrow: it only modifies inputs that
 * FAIL JSON.parse, and only applies the two specific transforms above. If
 * the post-transform string still fails to parse, return null so the caller
 * (AI SDK's repairToolCall hook) falls through to InvalidToolInputError.
 *
 * Tests live in tool-args-repair.test.ts and pin both observed samples
 * plus a control "valid JSON is never modified" assertion.
 */

const MAX_INPUT_LENGTH = 50_000;
const MAX_TRAILING_BRACE_STRIPS = 5;

/**
 * Try to recover a JSON object from a malformed tool-call argument string.
 *
 * Returns:
 *   - { ok: true, value, transforms } when JSON.parse succeeds after repair
 *     (or initially — same fast-path return so callers can be uniform).
 *   - { ok: false } when the string still fails to parse after all
 *     conservative transforms. Caller should report tool-error.
 */
export type RepairResult = { ok: true; value: unknown; transforms: string[] } | { ok: false };

export function repairToolCallArgs(raw: string): RepairResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false };
  if (raw.length > MAX_INPUT_LENGTH) return { ok: false };

  // Fast path: already valid JSON.
  const initial = tryParse(raw);
  if (initial.ok) return { ok: true, value: initial.value, transforms: [] };

  let working = raw;
  const transforms: string[] = [];

  // (1) Strip Qwen native-format suffix garbage. Multiple leak shapes seen.
  const stripped = stripNativeFormatLeak(working);
  if (stripped !== working) {
    working = stripped;
    transforms.push("strip-native-tags");
    const after = tryParse(working);
    if (after.ok) return { ok: true, value: after.value, transforms };
  }

  // (2) Insert missing close-quote after escape-sequence end. The pattern
  // we've seen is `\\}, "key":` — string ended with a `\\}` (escaped brace
  // inside a regex) and the model dropped the closing `"`. Same logic
  // applies to `\\]`, `\\)`, `\\>` and other escape-bracket-close sequences.
  //
  // Runs BEFORE strip-trailing-braces because the missing quote confuses the
  // brace counter (it thinks the trailing `}}` is inside an open string).
  const quoteFixed = insertMissingCloseQuote(working);
  if (quoteFixed !== working) {
    working = quoteFixed;
    transforms.push("insert-missing-close-quote");
    const after = tryParse(working);
    if (after.ok) return { ok: true, value: after.value, transforms };
  }

  // (3) Balance trailing braces. Models often emit one extra closing `}`.
  // Now safe to run because quote fixup put the string boundaries back so
  // the brace counter walks the structure correctly.
  const balanced = stripUnbalancedTrailingBraces(working);
  if (balanced !== working) {
    working = balanced;
    transforms.push("strip-trailing-braces");
    const after = tryParse(working);
    if (after.ok) return { ok: true, value: after.value, transforms };
  }

  return { ok: false };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Strip Qwen native chat-format leakage that appears in OpenAI-compatible
 * `arguments` strings. Patterns observed:
 *   - trailing `</tool_call>` literal
 *   - trailing `</tool_calls>` literal (plural variant)
 *   - trailing `<|tool_call_end|>` sentinel
 *   - whitespace + extra newlines after either of the above
 * Strips ONLY at the trailing end. Body of the JSON is not touched, so
 * legitimate strings that happen to contain `<tool_call>` as data are safe.
 */
function stripNativeFormatLeak(s: string): string {
  return s.replace(/\s*(?:<\/tool_calls?>|<\|tool_call(?:_end)?\|>)\s*$/i, "");
}

/**
 * If the string has more closing `}` than opening `{`, strip trailing `}`
 * one at a time (skipping whitespace) until balanced — but only up to
 * MAX_TRAILING_BRACE_STRIPS so a wildly malformed string doesn't get
 * gutted. The check is naive (doesn't track string vs object braces) which
 * is OK because we only run this when the original parse already failed.
 */
function stripUnbalancedTrailingBraces(s: string): string {
  let open = 0;
  let close = 0;
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") open++;
    else if (ch === "}") close++;
  }
  let extra = close - open;
  if (extra <= 0) return s;
  if (extra > MAX_TRAILING_BRACE_STRIPS) return s; // too damaged, refuse
  let out = s;
  while (extra > 0) {
    const trimmed = out.replace(/\s+$/, "");
    if (!trimmed.endsWith("}")) break;
    out = trimmed.slice(0, -1);
    extra--;
  }
  return out;
}

/**
 * Insert a missing close-quote on the value of a JSON key=value pair where
 * the model emitted an escape sequence as the final visible characters
 * before the next key. Pattern:
 *   ...\\X,  "next-key":...
 * where X is `}`, `]`, `)`, `>` or another `\\` — i.e. characters that the
 * tokenizer treats as escape-sequence terminators. The fix inserts `"`
 * between the escape and the comma:
 *   ...\\X",  "next-key":...
 *
 * Refuses to fire when the input already contains a balanced quote count
 * preceding the comma — that means the failure is something other than a
 * missing close-quote and our naive insert would corrupt valid JSON.
 *
 * The regex is anchored to "comma + maybe-whitespace + ASCII-key-start"
 * which strongly suggests a JSON-object key boundary, not arbitrary text.
 */
function insertMissingCloseQuote(s: string): string {
  // Match: backslash-sequence (\\X), optional space, comma, optional space,
  // quote, ASCII key letter. Captures the escape so we can re-emit it +
  // an inserted close-quote.
  // Char class members: `}`, `]` (escaped), `)`, `>`, `\` (escaped).
  const pattern = /(\\\\[}\])>\\])(\s*,\s*)("[A-Za-z_])/g;
  const out = s;
  let lastIndex = 0;
  let result = "";
  let matched = false;
  pattern.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec loop
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(out)) !== null) {
    // Safety: only fire when the prefix has ODD number of unescaped quotes
    // (i.e. we're inside an open string). Otherwise valid JSON containing
    // `\\}` followed by a comma would get corrupted.
    const prefix = out.slice(0, m.index);
    if (!isInsideOpenString(prefix)) continue;
    result += `${out.slice(lastIndex, m.index) + m[1]}"${m[2]}${m[3]}`;
    lastIndex = m.index + m[0].length;
    matched = true;
  }
  if (!matched) return s;
  result += out.slice(lastIndex);
  return result;
}

/**
 * True iff `prefix` has an odd number of un-escaped `"` characters — i.e.
 * the next character would be inside an open JSON string.
 */
function isInsideOpenString(prefix: string): boolean {
  let count = 0;
  let escaped = false;
  for (const ch of prefix) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') count++;
  }
  return count % 2 === 1;
}

export const _internals = {
  stripNativeFormatLeak,
  stripUnbalancedTrailingBraces,
  insertMissingCloseQuote,
  isInsideOpenString,
};
