export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
  if (!text || !text.includes("\\confidence")) return text;
  // Trailing form (most common) — also swallow the whitespace/newline before it.
  let out = text.replace(/\s*\\confidence\s*\{[^}]*\}\s*$/i, "");
  // Any remaining mid-text occurrences.
  out = out.replace(/\\confidence\s*\{[^}]*\}/gi, "");
  return out;
}
