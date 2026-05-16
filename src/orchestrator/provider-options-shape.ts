/**
 * src/orchestrator/provider-options-shape.ts
 *
 * Helper for Phase O1 cost-leak forensics — records the SHAPE (not the
 * values) of providerOptions passed to streamText alongside each usage
 * event. Lets post-mortem answer "did this call carry store=true?" /
 * "was promptCacheKey present?" without leaking actual key material.
 *
 * Shape format: leaves are replaced with their typeof string. Example:
 *   {openai: {store: true, promptCacheKey: "abc123"}, anthropic: {thinking: {budgetTokens: 8192}}}
 * becomes:
 *   {openai: {store: "boolean", promptCacheKey: "string"}, anthropic: {thinking: {budgetTokens: "number"}}}
 *
 * Recursion is depth-capped to prevent runaway on circular refs or
 * pathological provider quirks.
 */

const MAX_DEPTH = 4;
const TRUNCATED = "<max-depth>";

type ShapeLeaf = string;
type ShapeNode = ShapeLeaf | { [key: string]: ShapeNode } | ShapeNode[];

function walk(value: unknown, depth: number): ShapeNode {
  if (depth >= MAX_DEPTH) return TRUNCATED;

  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint" || t === "symbol" || t === "function") {
    return t;
  }
  if (t === "undefined") return "undefined";

  if (Array.isArray(value)) {
    // Preserve array structure; recurse into each element.
    return (value as unknown[]).map((v) => walk(v, depth + 1));
  }

  if (t === "object") {
    const out: { [key: string]: ShapeNode } = {};
    for (const key of Object.keys(value as object)) {
      out[key] = walk((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }

  // Fallback for exotic types.
  return t;
}

/**
 * Extract a JSON-serialisable shape of providerOptions, replacing
 * string/number/boolean leaves with their type names. Returns null for
 * null/undefined/empty inputs so the caller can store it as a NULL DB
 * column rather than `"{}"`.
 */
export function extractProviderOptionsShape(opts: unknown): string | null {
  if (opts === null || opts === undefined) return null;
  if (typeof opts !== "object") return null;
  if (Array.isArray(opts) && opts.length === 0) return null;
  if (!Array.isArray(opts) && Object.keys(opts as object).length === 0) return null;

  const shape = walk(opts, 0);
  try {
    return JSON.stringify(shape);
  } catch {
    // Defensive: should be unreachable since walk produces plain values only.
    return null;
  }
}
