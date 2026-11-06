/**
 * src/tools/empty-catch-scan.ts
 *
 * Host enforcement of the No Silent Catch rule (repo CLAUDE.md / AGENTS.md):
 * after write_file / edit_file, scan the lines the write ADDED for an error
 * handler with no statement in it — `catch {}`, `catch (e) { /* … *\/ }`,
 * `.catch(() => {})`, Python `except …: pass`. The result is a structured
 * WARNING on the tool result (not a block): the model reads it on the very next
 * step, which a prompt rule it can attention-decay past never guaranteed.
 *
 * Deliberately cheap and language-aware: one regex pass over the new content
 * for brace languages, one line pass for Python, keyed by file extension.
 * Unknown extensions are not scanned. A handler that contains ANY statement
 * (a log call, a rethrow, a fallback assignment) is not flagged; comments
 * alone do not count as a statement — "explain why" must come WITH a log.
 */
import { diffLines } from "diff";

export interface QualityWarning {
  rule: "no-silent-catch";
  kind: "empty-catch" | "empty-promise-catch" | "except-pass";
  /** 1-based line in the NEW content where the handler starts. */
  line: number;
  snippet: string;
}

const BRACE_LANG_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".cs",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".dart",
  ".php",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".groovy",
]);
const PYTHON_EXT = new Set([".py", ".pyi"]);

/** Whitespace, line comments and block comments only — no statement. */
const EMPTY_BODY = String.raw`(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*`;
// `catch {}` / `catch (e) {}` / `catch (Exception ex) when (x) {}` with an empty body.
const EMPTY_CATCH_RE = new RegExp(
  String.raw`\bcatch\b\s*(?:\([^()]*\)\s*)?(?:when\s*\([^()]*\)\s*)?\{${EMPTY_BODY}\}`,
  "g",
);
// `.catch(() => {})`, `.catch((_e) => undefined)`, `.catch(function () {})`.
const EMPTY_PROMISE_CATCH_RE = new RegExp(
  String.raw`\.catch\(\s*(?:async\s*)?(?:(?:\(\s*[\w$]*\s*(?::\s*[\w$]+)?\s*\)|[\w$]+)\s*=>\s*(?:\{${EMPTY_BODY}\}|undefined|void 0)|function\s*[\w$]*\s*\([^()]*\)\s*\{${EMPTY_BODY}\})\s*\)`,
  "g",
);

function extensionOf(filePath: string): string {
  const m = filePath.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

/** 1-based line numbers of `after` that the write added (all lines for a new file). */
export function addedLineNumbers(before: string, after: string): Set<number> {
  const added = new Set<number>();
  let line = 1;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split("\n").length - (part.value.endsWith("\n") ? 1 : 0);
    if (part.added) for (let i = 0; i < count; i++) added.add(line + i);
    if (!part.removed) line += count;
  }
  return added;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** True when `index` sits inside a line comment or (heuristically) a string literal. */
function inCommentOrString(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const prefix = content.slice(lineStart, index);
  const trimmed = prefix.trimStart();
  if (prefix.includes("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
  for (const q of ['"', "'", "`"]) {
    if ((prefix.split(q).length - 1) % 2 === 1) return true;
  }
  return false;
}

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function scanBraceLanguage(after: string, added: Set<number>): QualityWarning[] {
  const out: QualityWarning[] = [];
  const scan = (re: RegExp, kind: QualityWarning["kind"]) => {
    re.lastIndex = 0;
    for (let m = re.exec(after); m; m = re.exec(after)) {
      if (inCommentOrString(after, m.index)) continue;
      const start = lineAt(after, m.index);
      const end = start + (m[0].match(/\n/g)?.length ?? 0);
      let touched = false;
      for (let l = start; l <= end && !touched; l++) touched = added.has(l);
      if (touched) out.push({ rule: "no-silent-catch", kind, line: start, snippet: snippetOf(m[0]) });
    }
  };
  scan(EMPTY_CATCH_RE, "empty-catch");
  scan(EMPTY_PROMISE_CATCH_RE, "empty-promise-catch");
  return out;
}

const PY_EXCEPT_RE = /^(\s*)except\b[^:\n]*:\s*(.*)$/;
const PY_NOOP_RE = /^(?:pass|\.\.\.)\s*(?:#.*)?$/;

function scanPython(after: string, added: Set<number>): QualityWarning[] {
  const lines = after.split("\n");
  const out: QualityWarning[] = [];
  const indentOf = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(PY_EXCEPT_RE);
    if (!m) continue;
    const inline = m[2]!.trim();
    const bodyLines: number[] = [];
    let silent: boolean;
    if (inline && !inline.startsWith("#")) {
      silent = PY_NOOP_RE.test(inline);
      bodyLines.push(i);
    } else {
      const exceptIndent = indentOf(lines[i]!);
      silent = true;
      let any = false;
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j]!;
        const t = raw.trim();
        if (!t || t.startsWith("#")) continue;
        if (indentOf(raw) <= exceptIndent) break;
        any = true;
        bodyLines.push(j);
        if (!PY_NOOP_RE.test(t)) {
          silent = false;
          break;
        }
      }
      silent = silent && any;
    }
    if (!silent) continue;
    const touched = [i, ...bodyLines].some((idx) => added.has(idx + 1));
    if (touched)
      out.push({
        rule: "no-silent-catch",
        kind: "except-pass",
        line: i + 1,
        snippet: snippetOf([lines[i], ...bodyLines.filter((b) => b !== i).map((b) => lines[b])].join(" ")),
      });
  }
  return out;
}

/** Silent error handlers on lines this write added. Never throws. */
export function scanAddedSilentCatches(filePath: string, before: string, after: string): QualityWarning[] {
  const ext = extensionOf(filePath);
  const brace = BRACE_LANG_EXT.has(ext);
  const python = PYTHON_EXT.has(ext);
  if (!brace && !python) return [];
  if (!/\bcatch\b|\bexcept\b/.test(after)) return [];
  const added = addedLineNumbers(before, after);
  if (added.size === 0) return [];
  return brace ? scanBraceLanguage(after, added) : scanPython(after, added);
}

/** The text appended to a write/edit acknowledgement when warnings exist. */
export function formatQualityWarnings(filePath: string, warnings: QualityWarning[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.slice(0, 10).map((w) => `  • ${filePath}:${w.line} ${w.kind} — \`${w.snippet}\``);
  if (warnings.length > 10) lines.push(`  … and ${warnings.length - 10} more`);
  return (
    "\n[host warning — no-silent-catch: error handler(s) you added swallow the error with no statement:\n" +
    `${lines.join("\n")}\n` +
    "Log the error with context (module, operation, message; HTTP status/body when relevant) or handle/rethrow it. " +
    "An intentional ignore needs a comment AND a debug-level log.]"
  );
}
