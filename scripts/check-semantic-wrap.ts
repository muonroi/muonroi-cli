/**
 * scripts/check-semantic-wrap.ts
 *
 * Audit script: warn when a .tsx file under src/ui/ exports a component whose
 * outermost JSX return is NOT wrapped in <Semantic>.
 *
 * Usage:  bun scripts/check-semantic-wrap.ts
 * Exit:   always 0 (warn-only; does not block CI)
 *
 * Approach:
 *   - Uses lightweight regex / text scanning (no full AST parser required).
 *   - Strategy: locate `return (` or `return <` in the file, then check that the
 *     first non-whitespace JSX tag is <Semantic.
 *   - False positives are acceptable; false negatives (missed un-wrapped roots)
 *     are worse, so we err on the side of flagging.
 *
 * Trade-off vs. a real ESLint/Biome plugin:
 *   - This project uses Biome (not ESLint). Biome's plugin system (WASM-based)
 *     requires ~1–2h of boilerplate to wire a custom diagnostic. A standalone
 *     script is simpler, equally discoverable via package.json, and integrates
 *     with the same CI pipeline as other bun scripts. Migrate to a Biome plugin
 *     once the team adopts the Biome plugin SDK at stable.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const UI_DIR = join(REPO_ROOT, "src", "ui");
const ALLOW_FILE = join(__dirname, ".semantic-wrap-allow.txt");

// ---------------------------------------------------------------------------
// Load allowlist
// ---------------------------------------------------------------------------

function loadAllowlist(allowFile: string): string[] {
  try {
    const raw = readFileSync(allowFile, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function matchesGlob(relPath: string, pattern: string): boolean {
  // Convert simple glob (with * and **) to a regex.
  // relPath uses forward slashes.
  // Two-pass substitution: replace ** first (before *), using a unique placeholder string.
  const GLOBSTAR = "__GLOBSTAR__";
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&") // escape special regex chars (except * ?)
    .replace(/\*\*/g, GLOBSTAR) // protect ** before collapsing *
    .replace(/\*/g, "[^/]*") // * matches within one segment
    .replace(new RegExp(GLOBSTAR, "g"), ".*"); // ** matches across segments
  const re = new RegExp(`^${escaped}$`);
  return re.test(relPath.replace(/\\/g, "/"));
}

function isAllowed(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => matchesGlob(relPath, pattern));
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

// ---------------------------------------------------------------------------
// Detection heuristic
//
// A file "needs" Semantic when:
//   1. It contains at least one JSX return statement (return (\n* <  OR  return <).
//   2. That return's outermost tag is NOT <Semantic (possibly with attributes).
//
// We look at the first JSX return in the file (covering the main exported component).
// ---------------------------------------------------------------------------

const RETURN_JSX_RE = /\breturn\s*\(?\s*(<[A-Z<>])/gm;
const RETURN_SEMANTIC_RE = /\breturn\s*\(?\s*<Semantic[\s>]/;

interface Finding {
  file: string;
  line: number;
}

function checkFile(filePath: string): Finding | null {
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");

  // Quick bail: no JSX at all
  if (!RETURN_JSX_RE.test(src)) return null;
  RETURN_JSX_RE.lastIndex = 0; // reset after test

  // If the file already has a return <Semantic somewhere, consider it wrapped.
  if (RETURN_SEMANTIC_RE.test(src)) return null;

  // Find the first `return (` or `return <UpperCase` line.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\breturn\s*\(?\s*<[A-Z<>]/.test(line)) {
      return { file: filePath, line: i + 1 };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allowlist = loadAllowlist(ALLOW_FILE);
const allTsx = collectTsx(UI_DIR);

const warnings: Finding[] = [];

for (const absPath of allTsx) {
  const relPath = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
  if (isAllowed(relPath, allowlist)) continue;
  const finding = checkFile(absPath);
  if (finding) {
    warnings.push({ ...finding, file: relPath });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (warnings.length === 0) {
  console.log("✔  check-semantic-wrap: all src/ui/ components appear to have <Semantic> root wrapping.");
} else {
  console.warn(
    `\n⚠  check-semantic-wrap: ${warnings.length} component(s) in src/ui/ are missing a <Semantic> root wrap.\n`,
  );
  for (const w of warnings) {
    console.warn(`  ${w.file}:${w.line}`);
    console.warn(
      `    → Wrap the outermost JSX with <Semantic id="..." role="..."> so the agent harness can observe it.`,
    );
    console.warn(`      See CLAUDE.md → "Adding a new TUI component".`);
    console.warn();
  }
  console.warn(`  To suppress a file, add its path (relative to repo root) to scripts/.semantic-wrap-allow.txt.\n`);
}

// Always exit 0 — warn-only, does not block CI.
process.exit(0);
