/**
 * scripts/check-semantic-wrap.ts
 *
 * Audit script: warn when a .tsx file under src/ui/ exports a component whose
 * outermost JSX return is NOT wrapped in <Semantic>.
 *
 * Usage:  bun scripts/check-semantic-wrap.ts
 * Exit:   always 0 (warn-only; does not block CI)
 *
 * Core detection logic lives in @muonroi/agent-harness-core/lint so it can be
 * reused in tests and other tooling without spawning a subprocess.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnwrappedComponents } from "../packages/agent-harness-core/src/lint.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ALLOW_FILE = join(__dirname, ".semantic-wrap-allow.txt");

const warnings = await findUnwrappedComponents({
  rootDir: REPO_ROOT,
  patterns: ["src/ui/**/*.tsx"],
  allowlistPath: ALLOW_FILE,
  wrapperNames: ["Semantic"],
});

if (warnings.length === 0) {
  console.log("✔  check-semantic-wrap: all src/ui/ components appear to have <Semantic> root wrapping.");
} else {
  console.warn(
    `\n⚠  check-semantic-wrap: ${warnings.length} component(s) in src/ui/ are missing a <Semantic> root wrap.\n`,
  );
  for (const w of warnings) {
    console.warn(`  ${w.path}:${w.line}`);
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
