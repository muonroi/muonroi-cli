/**
 * codebase-intel.ts — P14 deterministic codebase analysis.
 *
 * Given a maintenance task description + cwd, produces a CodebaseIntel struct
 * that tells the downstream P15 task-runner: which files matter, what is the
 * impact radius, which tests cover the area, what framework is in play.
 *
 * NO LLM calls — pure grep/regex/heuristics. Sub-second on a 1000-file repo.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ensureRepoMap } from "./repo-map.js";
import type { CandidateFile, CodebaseIntel, MaintenanceTask } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".cs", ".go", ".rs", ".java", ".kt", ".rb"]);

/** Max bytes to read per file when scoring body keyword hits. */
const MAX_FILE_READ_BYTES = 100 * 1024; // 100 KB

/** Directories to skip when walking. Kept in sync with repo-map.ts. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".venv",
  ".idea",
  ".vscode",
  ".planning",
]);

/** English + Vietnamese common stopwords to drop from keyword extraction. */
const STOPWORDS = new Set([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "up",
  "out",
  "as",
  "or",
  "and",
  "but",
  "not",
  "that",
  "this",
  "it",
  "its",
  "we",
  "you",
  "i",
  "he",
  "she",
  "they",
  "do",
  "did",
  "does",
  "has",
  "have",
  "had",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "into",
  "about",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "than",
  "then",
  "so",
  "if",
  "all",
  "also",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "only",
  "own",
  "same",
  "too",
  "very",
  "just",
  "now",
  "new",
  "use",
  "used",
  // Vietnamese common
  "có",
  "là",
  "một",
  "sẽ",
  "được",
  "không",
  "và",
  "của",
  "với",
  "trong",
  "trên",
  "để",
  "đã",
  "đang",
  "cho",
  "khi",
  "như",
  "hay",
  "thì",
  "bị",
  "cần",
  "các",
  "từ",
  "nên",
  "vào",
  "ra",
  "lên",
  "xuống",
  "này",
  "đó",
  "về",
  "tại",
]);

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GatherIntelInput {
  cwd: string;
  task: Pick<MaintenanceTask, "title" | "description" | "kind">;
  maxCandidates?: number; // default 5
  maxImpactFiles?: number; // default 15
}

/**
 * Main P14 entry point. Deterministic — no LLM calls.
 */
export async function gatherCodebaseIntel(input: GatherIntelInput): Promise<CodebaseIntel> {
  const { cwd, task, maxCandidates = 5, maxImpactFiles = 15 } = input;

  // 1. Repo map (D4: reuse existing if present)
  const repoMapResult = await ensureRepoMap(cwd);

  // 2. Keyword extraction
  const keywords = extractKeywords(`${task.title} ${task.description}`);

  // 3. Candidate ranking
  const candidates = await rankCandidates(cwd, keywords, maxCandidates);

  // 4. Impact radius
  const impactRadius = await findImpactRadius(cwd, candidates, maxImpactFiles);

  // 5. Regression tests
  const regressionTests = await findRegressionTests(cwd, candidates, impactRadius);

  // 6. Framework detection
  const detectedFrameworks = await detectFrameworks(cwd);

  return {
    cwd,
    repoMap: repoMapResult.content,
    repoMapSource: repoMapResult.source,
    candidateFiles: candidates,
    impactRadius,
    regressionTests,
    detectedFrameworks,
    capturedAtUtc: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — Keyword extraction
// ---------------------------------------------------------------------------

/** Exposed for testing. */
export function extractKeywords(text: string): string[] {
  // Lowercase, split on whitespace + punctuation
  const tokens = text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);

  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const token of tokens) {
    // Drop short tokens, pure numbers, stopwords, already seen
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }

  // Cap at top 10 — sort by length desc (longer = more specific), then alpha for determinism
  return keywords.sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Step 3 — Candidate ranking
// ---------------------------------------------------------------------------

async function rankCandidates(cwd: string, keywords: string[], maxCandidates: number): Promise<CandidateFile[]> {
  if (keywords.length === 0) return [];

  interface FileScore {
    path: string;
    totalScore: number;
    reasons: string[];
  }

  const scores = new Map<string, FileScore>();

  async function visit(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(path.join(dir, name));
      } else {
        const ext = path.extname(name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, name);
        const rel = path.relative(cwd, fullPath).replace(/\\/g, "/");
        const score = await scoreFile(rel, fullPath, name, keywords);
        if (score.totalScore > 0) {
          scores.set(rel, score);
        }
      }
    }
  }

  await visit(cwd);

  // Sort descending by totalScore, take top maxCandidates
  const sorted = Array.from(scores.values()).sort((a, b) => b.totalScore - a.totalScore);
  const top = sorted.slice(0, maxCandidates);

  return top.map((s) => ({
    path: s.path,
    reason: s.reasons.join("; "),
    matchScore: Math.min(1, s.totalScore / (5 * keywords.length)),
  }));
}

async function scoreFile(
  relPath: string,
  fullPath: string,
  name: string,
  keywords: string[],
): Promise<{ path: string; totalScore: number; reasons: string[] }> {
  const basename = path.basename(name, path.extname(name)).toLowerCase();
  const lowerRel = relPath.toLowerCase();
  let totalScore = 0;
  const reasons: string[] = [];
  const filenameMatches: string[] = [];
  const pathMatches: string[] = [];
  let bodyHits = 0;

  for (const kw of keywords) {
    // +5 per keyword found in basename
    if (basename.includes(kw)) {
      totalScore += 5;
      filenameMatches.push(kw);
    }
    // +3 if keyword appears in the path (directory components)
    const dirPart = path.dirname(lowerRel);
    if (dirPart.includes(kw)) {
      totalScore += 3;
      pathMatches.push(kw);
    }
  }

  // +1 per keyword in body (read up to MAX_FILE_READ_BYTES)
  try {
    const buf = await fs.readFile(fullPath, "utf8");
    const body = buf.slice(0, MAX_FILE_READ_BYTES).toLowerCase();
    for (const kw of keywords) {
      if (body.includes(kw)) {
        totalScore += 1;
        bodyHits++;
      }
    }
  } catch {
    // unreadable — skip body score
  }

  if (filenameMatches.length > 0) {
    reasons.push(`filename matches: ${filenameMatches.join(", ")}`);
  }
  if (pathMatches.length > 0) {
    reasons.push(`path contains: ${pathMatches.join(", ")}`);
  }
  if (bodyHits > 0) {
    reasons.push(`${bodyHits} keyword hit${bodyHits > 1 ? "s" : ""} in body`);
  }

  return { path: relPath, totalScore, reasons };
}

// ---------------------------------------------------------------------------
// Step 4 — Impact radius
// ---------------------------------------------------------------------------

async function findImpactRadius(cwd: string, candidates: CandidateFile[], maxImpact: number): Promise<string[]> {
  if (candidates.length === 0) return [];

  // Build set of basenames (without extension) to look for
  const basenames = candidates.map((c) => path.basename(c.path, path.extname(c.path)));

  const importing = new Set<string>();

  async function visit(dir: string): Promise<void> {
    if (importing.size >= maxImpact) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (importing.size >= maxImpact) return;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(path.join(dir, name));
      } else {
        const ext = path.extname(name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, name);
        const rel = path.relative(cwd, fullPath).replace(/\\/g, "/");
        // Skip if the file itself is a candidate
        if (candidates.some((c) => c.path === rel)) continue;
        const found = await fileImportsAny(fullPath, basenames, ext);
        if (found) importing.add(rel);
      }
    }
  }

  await visit(cwd);
  return Array.from(importing).slice(0, maxImpact);
}

/** Returns true if the file imports any of the given basenames. */
async function fileImportsAny(fullPath: string, basenames: string[], ext: string): Promise<boolean> {
  let content: string;
  try {
    const buf = await fs.readFile(fullPath, "utf8");
    content = buf.slice(0, MAX_FILE_READ_BYTES);
  } catch {
    return false;
  }

  const lower = content.toLowerCase();

  for (const base of basenames) {
    const lowerBase = base.toLowerCase();

    // JS/TS: from '...base...' or require('...base...')
    if (/\.[jt]sx?$/.test(ext)) {
      const tsPattern = new RegExp(`from\\s+['"][^'"]*${escapeRegex(lowerBase)}['"]`);
      const cjsPattern = new RegExp(`require\\s*\\(\\s*['"][^'"]*${escapeRegex(lowerBase)}['"]`);
      if (tsPattern.test(lower) || cjsPattern.test(lower)) return true;
    }

    // C#: using ... Base
    if (ext === ".cs") {
      const csPattern = new RegExp(`using\\s+[\\w.]*${escapeRegex(base)}`, "i");
      if (csPattern.test(content)) return true;
    }

    // Python: import base or from ... import
    if (ext === ".py") {
      const pyPattern = new RegExp(`(?:import|from)\\s+[\\w.]*${escapeRegex(lowerBase)}`, "i");
      if (pyPattern.test(lower)) return true;
    }

    // Go: import "...base..."
    if (ext === ".go") {
      const goPattern = new RegExp(`import\\s+[^"]*"[^"]*${escapeRegex(lowerBase)}`);
      if (goPattern.test(lower)) return true;
    }

    // Generic fallback — any import/require/using line containing the basename
    if (lower.includes(lowerBase) && /import|require|using/.test(lower)) return true;
  }

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Step 5 — Regression tests
// ---------------------------------------------------------------------------

const TEST_PATTERNS = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /_test\.go$/, /Test\.cs$/, /_test\.py$/];
const TEST_DIRS = ["tests", "__tests__", "test", "spec"];

function isTestFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return TEST_PATTERNS.some((p) => p.test(name));
}

async function findRegressionTests(
  cwd: string,
  candidates: CandidateFile[],
  impactRadius: string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const basenames = candidates.map((c) => path.basename(c.path, path.extname(c.path)).toLowerCase());
  const result = new Set<string>();

  // Filter impactRadius for test files
  for (const f of impactRadius) {
    if (isTestFile(f)) result.add(f);
  }

  // Walk standard test dirs explicitly
  for (const testDir of TEST_DIRS) {
    const dirPath = path.join(cwd, testDir);
    try {
      await walkTestDir(dirPath, cwd, basenames, result);
    } catch {
      // dir doesn't exist — skip
    }
  }

  return Array.from(result);
}

async function walkTestDir(dir: string, cwd: string, basenames: string[], result: Set<string>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    const fullPath = path.join(dir, name);
    if (entry.isDirectory()) {
      await walkTestDir(fullPath, cwd, basenames, result);
    } else {
      if (!isTestFile(name)) continue;
      // Check if it references any candidate basename
      try {
        const buf = await fs.readFile(fullPath, "utf8");
        const lower = buf.slice(0, MAX_FILE_READ_BYTES).toLowerCase();
        if (basenames.some((b) => lower.includes(b))) {
          result.add(path.relative(cwd, fullPath).replace(/\\/g, "/"));
        }
      } catch {
        // skip unreadable
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6 — Framework detection
// ---------------------------------------------------------------------------

async function detectFrameworks(cwd: string): Promise<string[]> {
  const frameworks = new Set<string>();

  // package.json — always present for node projects
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    frameworks.add("node");
    if ("next" in allDeps) frameworks.add("next");
    if ("react" in allDeps || "react-dom" in allDeps) frameworks.add("react");
    if ("vue" in allDeps) frameworks.add("vue");
    if ("@angular/core" in allDeps) frameworks.add("angular");
  } catch {
    // no package.json — not node
  }

  // .csproj or .sln files anywhere in root or subdirs (depth 2)
  const hasDotnet = await hasFileMatching(cwd, [".csproj", ".sln"], 2);
  if (hasDotnet) frameworks.add("dotnet");

  // Python
  const hasPython =
    (await fileExists(path.join(cwd, "pyproject.toml"))) ||
    (await fileExists(path.join(cwd, "requirements.txt"))) ||
    (await fileExists(path.join(cwd, "setup.py")));
  if (hasPython) frameworks.add("python");

  // Rust
  if (await fileExists(path.join(cwd, "Cargo.toml"))) frameworks.add("rust");

  // Go
  if (await fileExists(path.join(cwd, "go.mod"))) frameworks.add("go");

  // Java / Kotlin
  const hasJava = (await fileExists(path.join(cwd, "pom.xml"))) || (await fileExists(path.join(cwd, "build.gradle")));
  if (hasJava) frameworks.add("java");

  return Array.from(frameworks).sort();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Checks if any file with given extensions exists within maxDepth from dir. */
async function hasFileMatching(dir: string, exts: string[], maxDepth: number): Promise<boolean> {
  async function search(d: string, depth: number): Promise<boolean> {
    if (depth > maxDepth) return false;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!entry.isDirectory() && exts.includes(ext)) return true;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        if (await search(path.join(d, entry.name), depth + 1)) return true;
      }
    }
    return false;
  }
  return search(dir, 0);
}
