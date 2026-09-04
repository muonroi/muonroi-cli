/**
 * scripts/check-harness-skips.ts
 *
 * Audit script: scan tests/harness/**\/*.spec.ts and report the ratio of
 * skipped/todo specs vs total. Warn-only by default; exit 1 with --strict
 * when the ratio exceeds the threshold OR any skip/todo is not in the
 * allowlist at scripts/.harness-skips-allow.json.
 *
 * Usage:
 *   bun scripts/check-harness-skips.ts              # warn-only
 *   bun scripts/check-harness-skips.ts --strict     # CI mode: exit 1 on regression
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const HARNESS_DIR = join(REPO_ROOT, "tests", "harness");
const ALLOW_FILE = join(__dirname, ".harness-skips-allow.json");

const STRICT = process.argv.includes("--strict");
// Default threshold tracks current baseline of 12/33 ≈ 0.364. Set to 0.40 so
// adding one more skip without clearing an existing blocker warns/fails in
// strict mode. Tighten in a later phase as blockers clear.
const THRESHOLD = 0.4;

interface SkipHit {
  path: string;
  line: number;
  kind: "skip" | "todo";
  spec: string;
}

interface AllowEntry {
  path: string;
  line: number;
  reason: string;
  issue: string;
}

/** A `.skipIf` guard: exempt from the ratio, but reported so it cannot hide. */
interface GuardHit {
  path: string;
  line: number;
  /** "it" | "test" | "describe" — which level the guard is applied at. */
  level: string;
  /** The guard's condition source, e.g. `!!process.env.CI`. */
  condition: string;
  /** True when the condition references process.env.CI — i.e. CI does not run it. */
  disablesInCi: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

// Matches `it.skip(`, `it.todo(`, `test.skip(`, `describe.skip(`, … at the start
// of a line (allowing whitespace). `.skipIf(` is EXCLUDED — see GUARD_RE below.
//
// `test` is included alongside `it`/`describe` because it is a vitest alias for
// `it`: without it, `test.skip(...)` would be an invisible skip. (There are none
// today; this closes the hole rather than reacting to one.)
const SKIP_RE = /^\s*(it|test|describe)\.(skip|todo)\s*\(/;

/**
 * `.skipIf(` at ANY level — `describe` AND `it`/`test`.
 *
 * These are exempt from the skip ratio (the standing policy: a `.skipIf` is a
 * platform/env guard, not abandoned coverage) but they are NOT invisible: every
 * one is listed in the report below with its condition, and the ones that turn
 * themselves off in CI are called out separately.
 *
 * `it.skipIf` previously matched NEITHER regex — not the skip counter, not the
 * exemption — so it was absent from the report entirely. It is now treated
 * exactly like `describe.skipIf`. Treating it as a counted skip instead would
 * have created an arbitrage the checker rewards: converting an `it.skipIf` into
 * a `describe.skipIf` would clear the gate while disabling MORE tests.
 */
const GUARD_RE = /^\s*(it|test|describe)\.skipIf\s*\(\s*(.*?)\s*\)\s*\(?/;

const specFiles = walk(HARNESS_DIR).sort();
const hits: SkipHit[] = [];
const guards: GuardHit[] = [];

for (const file of specFiles) {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const guard = GUARD_RE.exec(line);
    if (guard) {
      const condition = guard[2] ?? "";
      guards.push({
        path: rel,
        line: i + 1,
        level: guard[1] ?? "",
        condition,
        disablesInCi: /process\.env(\.CI\b|\[["']CI["']\])/.test(condition),
      });
      continue;
    }
    const m = SKIP_RE.exec(line);
    if (!m) continue;
    hits.push({
      path: rel,
      line: i + 1,
      kind: m[2] as "skip" | "todo",
      spec: rel,
    });
  }
}

const total = specFiles.length;
const skipCount = hits.filter((h) => h.kind === "skip").length;
const todoCount = hits.filter((h) => h.kind === "todo").length;
const ratio = total === 0 ? 0 : (skipCount + todoCount) / total;

// Load allowlist
let allow: AllowEntry[] = [];
if (existsSync(ALLOW_FILE)) {
  try {
    allow = JSON.parse(readFileSync(ALLOW_FILE, "utf-8")) as AllowEntry[];
  } catch (err) {
    console.error(`✘ failed to parse ${ALLOW_FILE}:`, err);
    process.exit(2);
  }
}

const allowKey = (path: string, line: number) => `${path}:${line}`;
const allowSet = new Set(allow.map((e) => allowKey(e.path, e.line)));

const unknown: SkipHit[] = [];
for (const hit of hits) {
  if (!allowSet.has(allowKey(hit.path, hit.line))) unknown.push(hit);
}

console.log("─".repeat(72));
console.log("Harness skip/todo coverage report");
console.log("─".repeat(72));
console.log(`Total spec files:    ${total}`);
console.log(`.skip count:         ${skipCount}`);
console.log(`.todo count:         ${todoCount}`);
console.log(`Ratio:               ${(ratio * 100).toFixed(1)}% (threshold ${(THRESHOLD * 100).toFixed(0)}%)`);
console.log(`Allowlist entries:   ${allow.length}`);
console.log(`Unallowlisted hits:  ${unknown.length}`);
console.log(`.skipIf guards:      ${guards.length} (exempt from the ratio, listed below)`);
console.log("─".repeat(72));

if (guards.length > 0) {
  console.log("\n.skipIf guards (env/platform gates — NOT counted as skips):");
  for (const g of guards) {
    console.log(`  ${g.path}:${g.line} (${g.level}.skipIf) ${g.condition}`);
  }
  const ciDisabled = guards.filter((g) => g.disablesInCi);
  if (ciDisabled.length > 0) {
    console.log(`\n  ⚠ ${ciDisabled.length} of these gate on process.env.CI — those specs NEVER run in CI:`);
    for (const g of ciDisabled) console.log(`      ${g.path}:${g.line}`);
    console.log("      Whether that coverage gap is acceptable is a human policy call.");
  }
  console.log("");
}

if (unknown.length > 0) {
  console.warn("\n⚠ The following .skip/.todo sites are NOT in the allowlist:");
  for (const h of unknown) {
    console.warn(`  ${h.path}:${h.line} (.${h.kind})`);
  }
  console.warn(`\n  Add them to scripts/.harness-skips-allow.json (with reason + issue) or remove the skip.\n`);
}

const ratioBreach = ratio > THRESHOLD;
if (ratioBreach) {
  console.warn(`⚠ Skip ratio ${(ratio * 100).toFixed(1)}% exceeds threshold ${(THRESHOLD * 100).toFixed(0)}%.`);
}

if (STRICT && (ratioBreach || unknown.length > 0)) {
  console.error("\n✘ --strict mode: failing build.");
  process.exit(1);
}

if (!ratioBreach && unknown.length === 0) {
  console.log("✔ harness skip coverage within thresholds.");
}

process.exit(0);
