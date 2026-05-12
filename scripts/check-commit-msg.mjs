#!/usr/bin/env node
/**
 * Conventional Commits message lint.
 *
 * Enforces format:
 *   <type>(<scope>)?: <subject>
 *
 *   <type>     ∈ feat|fix|refactor|perf|test|docs|chore|build|ci|style|revert
 *   <scope>    optional, lowercase identifier
 *   <subject>  must start lowercase, no trailing dot, ≤ 72 chars
 *   Body       optional, separated by blank line, hard-wrap < 100 chars/line
 *
 * Reject vague titles ("add fix", "minor changes", "wip", "tmp"). Allows
 * merge/revert commits and Dependabot-generated bumps.
 *
 * Read message from $1 (path) — invoked by .husky/commit-msg as:
 *   node scripts/check-commit-msg.mjs "$1"
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: check-commit-msg.mjs <commit-msg-file>");
  process.exit(2);
}
const raw = fs.readFileSync(file, "utf8");
const firstLine = raw.split("\n")[0].trim();

if (!firstLine) {
  console.error("✗ commit message is empty");
  process.exit(1);
}

// Allowlist: merges, reverts, dependabot
if (
  /^Merge (branch|pull request|remote-tracking)/i.test(firstLine) ||
  /^Revert /.test(firstLine) ||
  /^chore\(deps\)/.test(firstLine)
) {
  process.exit(0);
}

const TYPES = "feat|fix|refactor|perf|test|docs|chore|build|ci|style|revert";
const HEADER_RE = new RegExp(`^(${TYPES})(\\([a-z0-9._-]+\\))?(!)?: .+`);

const VAGUE = [
  /^add\s*$/i,
  /^add fix$/i,
  /^minor( changes)?$/i,
  /^update$/i,
  /^wip\b/i,
  /^tmp\b/i,
  /^test\s*$/i,
  /^fix\s*$/i,
  /^addition advance seo/i,
];

const errors = [];

if (!HEADER_RE.test(firstLine)) {
  errors.push(
    `header does not match Conventional Commits format: "<type>(scope)?: subject"\n  allowed types: ${TYPES.replace(/\|/g, ", ")}`,
  );
}

const subject = firstLine.replace(new RegExp(`^(${TYPES})(\\([^)]+\\))?!?:\\s*`), "");
if (subject.length > 72) {
  errors.push(`header subject is ${subject.length} chars (max 72)`);
}
if (subject.endsWith(".")) {
  errors.push("header subject must not end with a period");
}
if (/^[A-Z]/.test(subject) && !/^[A-Z]{2,}/.test(subject)) {
  // Allow acronyms (e.g., "API", "CLI") but reject sentence case
  errors.push("header subject should start lowercase (or with an ACRONYM)");
}
for (const re of VAGUE) {
  if (re.test(firstLine)) {
    errors.push(`vague header rejected: "${firstLine}". Describe WHAT and WHY in ≤72 chars.`);
    break;
  }
}

// Body line length
const lines = raw.split("\n");
for (let i = 2; i < lines.length; i++) {
  const ln = lines[i];
  // Allow long URLs / Co-Authored-By trailers
  if (/^(https?:\/\/|Co-Authored-By:|Signed-off-by:|Fixes:|Refs:)/i.test(ln)) continue;
  if (ln.length > 100) {
    errors.push(`body line ${i + 1} is ${ln.length} chars (max 100)`);
    break;
  }
}

if (errors.length > 0) {
  console.error("\n✗ commit message rejected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nExamples:",
    "\n  fix(router): handle empty provider sentinel in warm path",
    "\n  feat(council): add adversarial debate phase",
    "\n  refactor(storage)!: rename atomic helpers (BREAKING)\n",
    "\nBypass (use sparingly): git commit --no-verify\n",
  );
  process.exit(1);
}
