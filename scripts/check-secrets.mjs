#!/usr/bin/env node
/**
 * Pre-commit secret + dev-config scanner.
 *
 * Blocks commits that include:
 *  - Paths under .claude/ (local dev permissions/settings)
 *  - .env / .env.* (any environment file)
 *  - user-settings.json (per-user provider config — may contain API keys)
 *  - Inline credential patterns in staged diff content
 *
 * Exits non-zero on detection. Designed to run from .husky/pre-commit.
 */
import { execSync } from "node:child_process";

const BLOCKED_PATHS = [/^\.claude\//, /^\.env(\.|$)/, /(^|\/)user-settings\.json$/];

// Project-level Claude Code config that IS safe to check in (no secrets) —
// settings.json wires hooks/tool-permissions for the whole team, and the
// hooks/ scripts must be versioned so every contributor's session fires the
// same automation (self-verify post-edit, etc.). Everything ELSE under
// .claude/ stays blocked (e.g. settings.local.json with personal allowlists).
const ALLOWED_CLAUDE_PATHS = [/^\.claude\/settings\.json$/, /^\.claude\/hooks\/[\w.-]+\.(c?js|mjs)$/];

const SECRET_PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI/DeepSeek/SiliconFlow key", re: /sk-(proj-)?[A-Za-z0-9]{32,}/ },
  { name: "xAI key", re: /xai-[A-Za-z0-9]{20,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Generic bearer secret", re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{16,}['"]/i },
];

function staged() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function diffContent() {
  return execSync("git diff --cached --no-color -U0", { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const files = staged();
const violations = [];

for (const f of files) {
  if (ALLOWED_CLAUDE_PATHS.some((re) => re.test(f))) continue;
  for (const re of BLOCKED_PATHS) {
    if (re.test(f)) {
      violations.push(`  blocked path: ${f}`);
      break;
    }
  }
}

const diff = diffContent();
const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
const addedText = addedLines.join("\n");

for (const { name, re } of SECRET_PATTERNS) {
  const m = addedText.match(re);
  if (m) {
    const snippet = m[0].slice(0, 12) + "…";
    violations.push(`  ${name}: ${snippet}`);
  }
}

if (violations.length > 0) {
  console.error("\n✗ pre-commit secret scan rejected this commit:\n");
  for (const v of violations) console.error(v);
  console.error("\nIf this is intentional (e.g. test fixture), bypass with: git commit --no-verify");
  console.error("Better: redact the value or move it out of the commit.\n");
  process.exit(1);
}
