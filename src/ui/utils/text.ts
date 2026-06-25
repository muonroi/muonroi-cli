export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * Strip invisible/control Unicode characters that leak into terminal output.
 * Keeps \t \n \r (needed for rendering); removes everything else that most
 * terminals cannot display safely: zero-width spaces, soft hyphens, BiDi
 * overrides, C0/C1 controls, BOM, and other default-ignorable code points.
 * Fast-pathed: returns the input unchanged when no match is found.
 *
 * Uses `new RegExp()` to avoid Biome's `noControlCharactersInRegex` lint
 * (control-char escapes in a regex literal are blocked).
 */
export function stripInvisibleChars(text: string): string {
  if (!text) return text;
  // Constructed via new RegExp to bypass Biome lint for control-char patterns.
  // U+034F (Combining Grapheme Joiner) is separated via alternation per
  // Biome's noMisleadingCharacterClass rule.
  const re = new RegExp(
    "[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u070F\u200B-\u200F\u2028-\u202F\u2060-\u2069\uFEFF\uFFF9-\uFFFB]|" +
      "\u034F|\u{1BCA0}-\u{1BCA3}|\u{E0001}|\u{E0020}-\u{E007F}",
    "gu",
  );
  return re.test(text) ? text.replace(re, "") : text;
}

export function trunc(s: string, n: number): string {
  const str = String(s ?? "");
  return str.length <= n ? str : `${str.slice(0, n)}…`;
}

export function truncateLine(s: string, n: number): string {
  return trunc(s.replace(/\s+/g, " ").trim(), n);
}

export function truncateBlock(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}

export function compactTaskLabel(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 3) return label.trim() || "Working";
  return `${words.slice(0, 3).join(" ")}...`;
}

export function sanitizeContent(raw: string): string {
  let s = raw.replace(/^[\s\n]*assistant:\s*/gi, "");
  s = s.replace(/\{"success"\s*:\s*(true|false)\s*,\s*"output"\s*:\s*"[\s\S]*$/m, "");
  return s.trim();
}

/**
 * Strip stray model self-annotation macros that leak into the user-facing answer
 * but are NOT instructed anywhere in the prompt. Currently: a trailing
 * `\confidence{NN}` macro emitted intermittently by grok-build. Conservative —
 * only the `\confidence{...}` form is removed, so legitimate LaTeX/code in an
 * answer (e.g. `\frac{a}{b}`) is untouched. Fast-pathed: no work when absent.
 */
export function stripStrayModelMacros(text: string): string {
  if (!text?.includes("\\confidence")) return text;
  // Trailing form (most common) — also swallow the whitespace/newline before it.
  let out = text.replace(/\s*\\confidence\s*\{[^}]*\}\s*$/i, "");
  // Any remaining mid-text occurrences.
  out = out.replace(/\\confidence\s*\{[^}]*\}/gi, "");
  return out;
}
