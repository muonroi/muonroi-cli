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

// Matches `it.skip(`, `it.todo(`, `describe.skip(`, `describe.todo(` at the
// start of a line (allowing whitespace). Explicitly excludes
// `describe.skipIf(` which is a legitimate platform/env guard, not coverage.
const SKIP_RE = /^\s*(it|describe)\.(skip|todo)\s*\(/;
const SKIPIF_RE = /^\s*describe\.skipIf\s*\(/;

const specFiles = walk(HARNESS_DIR).sort();
const hits: SkipHit[] = [];

for (const file of specFiles) {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (SKIPIF_RE.test(line)) continue;
    const m = SKIP_RE.exec(line);
    if (!m) continue;
    hits.push({
      path: relative(REPO_ROOT, file).replaceAll("\\", "/"),
      line: i + 1,
      kind: m[2] as "skip" | "todo",
      spec: relative(REPO_ROOT, file).replaceAll("\\", "/"),
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
console.log("─".repeat(72));

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
