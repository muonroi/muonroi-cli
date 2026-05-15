/**
 * packages/agent-harness-core/src/lint.ts
 *
 * Node-only helper: walk .tsx files and find components whose outermost JSX
 * return is NOT wrapped in <Semantic> (or a configured wrapper name).
 *
 * Exported as the `@muonroi/agent-harness-core/lint` sub-path.
 * DO NOT import this from browser-index.ts — it uses node:fs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FindUnwrappedOptions {
  /** Repo root (used for relative paths in results). */
  rootDir: string;
  /**
   * Glob-like patterns to scan, relative to rootDir.
   * Supports `*` (single segment) and `**` (multi-segment).
   * Example: ["src/ui/**\/*.tsx"]
   */
  patterns: string[];
  /** Path to an allowlist file (newline-separated relative paths). Optional. */
  allowlistPath?: string;
  /**
   * Names of wrapper components that count as semantic roots.
   * Defaults to ["Semantic"].
   */
  wrapperNames?: string[];
}

export interface UnwrappedResult {
  /** Relative path (forward slashes) of an unwrapped file. */
  path: string;
  /** 1-based line number of the first JSX return. */
  line: number;
  /** Root element name found (if detectable). */
  rootElement?: string;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function loadAllowlist(allowlistPath: string): string[] {
  if (!existsSync(allowlistPath)) return [];
  try {
    const raw = readFileSync(allowlistPath, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function globToRegex(pattern: string): RegExp {
  // Two-pass substitution: protect ** before collapsing *.
  const GLOBSTAR = "__GLOBSTAR__";
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&") // escape special regex chars (not * ?)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(GLOBSTAR, "g"), ".*");
  return new RegExp(`^${escaped}$`);
}

function isAllowed(relPath: string, allowlist: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return allowlist.some((pattern) => globToRegex(pattern).test(normalized));
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectTsx(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectTsx(full));
    } else if (entry.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
}

/** Collect all .tsx files that match at least one pattern relative to rootDir. */
function collectByPatterns(rootDir: string, patterns: string[]): string[] {
  // Build the set of directories to walk by finding the non-glob prefix of each pattern.
  const dirsToWalk = new Set<string>();
  for (const pattern of patterns) {
    // Take the leading non-glob path segments.
    const parts = pattern.replace(/\\/g, "/").split("/");
    const prefix: string[] = [];
    for (const part of parts) {
      if (part.includes("*") || part.includes("?")) break;
      prefix.push(part);
    }
    // Resolve to absolute; fall back to rootDir if no stable prefix.
    const dir = resolve(rootDir, prefix.join("/") || ".");
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      dirsToWalk.add(dir);
    }
  }

  // Walk each directory and filter by patterns.
  const regexes = patterns.map(globToRegex);
  const results: string[] = [];
  for (const dir of dirsToWalk) {
    for (const absPath of collectTsx(dir)) {
      const relPath = relative(rootDir, absPath).replace(/\\/g, "/");
      if (regexes.some((re) => re.test(relPath))) {
        results.push(absPath);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Detection heuristic
//
// A file "needs" Semantic when:
//   1. It contains at least one JSX return (return (\n* <UpperCase  OR  return <UpperCase).
//   2. That return's outermost tag is NOT one of the configured wrapper names.
// ---------------------------------------------------------------------------

const RETURN_JSX_RE = /\breturn\s*\(?\s*(<[A-Z<>])/gm;

function buildReturnWrapperRe(wrapperNames: string[]): RegExp {
  const alternation = wrapperNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`\\breturn\\s*\\(?\\s*<(${alternation})[\\s>]`);
}

function checkFile(filePath: string, wrapperNames: string[]): { line: number; rootElement?: string } | null {
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");

  // Quick bail: no JSX at all
  if (!RETURN_JSX_RE.test(src)) return null;
  RETURN_JSX_RE.lastIndex = 0;

  // If the file has any return <WrapperName…>, consider it wrapped.
  const wrapperRe = buildReturnWrapperRe(wrapperNames);
  if (wrapperRe.test(src)) return null;

  // Find the first `return (` or `return <UpperCase` line — report it.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\breturn\s*\(?\s*<([A-Z][A-Za-z0-9.]*)/);
    if (m) {
      return { line: i + 1, rootElement: m[1] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk .tsx files matching `opts.patterns` (relative to `opts.rootDir`) and
 * return those whose outermost JSX return is NOT wrapped in a Semantic component.
 *
 * Pure function — no console output, no process.exit.
 */
export async function findUnwrappedComponents(opts: FindUnwrappedOptions): Promise<UnwrappedResult[]> {
  const { rootDir, patterns, allowlistPath, wrapperNames = ["Semantic"] } = opts;

  const allowlist = allowlistPath ? loadAllowlist(allowlistPath) : [];
  const files = collectByPatterns(rootDir, patterns);

  const results: UnwrappedResult[] = [];
  for (const absPath of files) {
    const relPath = relative(rootDir, absPath).replace(/\\/g, "/");
    if (isAllowed(relPath, allowlist)) continue;
    const finding = checkFile(absPath, wrapperNames);
    if (finding) {
      results.push({ path: relPath, line: finding.line, rootElement: finding.rootElement });
    }
  }
  return results;
}
