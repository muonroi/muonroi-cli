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
import { findInteractiveWithoutSemantic, findUnwrappedComponents } from "../packages/agent-harness-core/src/lint.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ALLOW_FILE = join(__dirname, ".semantic-wrap-allow.txt");

// --strict makes NEW findings block CI (exit 1). Default is warn-only (exit 0)
// so the existing backlog does not immediately break the build.
const STRICT = process.argv.includes("--strict");

// Role-fixed primitives (src/ui/primitives) each embed <Semantic> internally,
// so a component whose root is one of these IS instrumented. Count them as
// valid semantic wrappers for the root-wrap check.
const PRIMITIVE_WRAPPERS = [
  "Semantic",
  "Dialog",
  "Region",
  "Panel",
  "TextBox",
  "Button",
  "Checkbox",
  "ListBox",
  "ListItem",
  "Menu",
  "MenuItem",
  "Toast",
  "StatusBar",
  "ProgressBar",
  "Log",
  "CustomBlock",
];

// Scan src/ui/ (TUI components) AND all adapter package fixture/test directories
// so that scaffolded React/Angular components are also checked.
const SCAN_PATTERNS = [
  "src/ui/**/*.tsx",
  // React adapter: component sources and __tests__ fixture apps
  "packages/agent-harness-react/src/**/*.tsx",
  "packages/agent-harness-react/__tests__/**/*.tsx",
  // Angular adapter: component sources (Angular uses .ts but exports JSX via TSX where applicable)
  "packages/agent-harness-angular/src/**/*.tsx",
  "packages/agent-harness-angular/__tests__/**/*.tsx",
];

const warnings = await findUnwrappedComponents({
  rootDir: REPO_ROOT,
  patterns: SCAN_PATTERNS,
  allowlistPath: ALLOW_FILE,
  wrapperNames: PRIMITIVE_WRAPPERS,
});

const interactive = await findInteractiveWithoutSemantic({
  rootDir: REPO_ROOT,
  patterns: SCAN_PATTERNS,
  allowlistPath: ALLOW_FILE,
});

const SCOPE_LABEL = "src/ui/, packages/agent-harness-react/, packages/agent-harness-angular/";

if (warnings.length === 0) {
  console.log(`✔  check-semantic-wrap: all components in ${SCOPE_LABEL} appear to have semantic root wrapping.`);
} else {
  console.warn(`\n⚠  check-semantic-wrap: ${warnings.length} component(s) are missing a semantic root wrap.\n`);
  for (const w of warnings) {
    console.warn(`  ${w.path}:${w.line}`);
    console.warn(
      `    → Wrap the outermost JSX with a primitive (<Dialog>/<TextBox>/<ListItem>/…) or <Semantic id role> so the agent harness can observe it.`,
    );
    console.warn(`      See CLAUDE.md → "Adding a new TUI component".`);
    console.warn();
  }
  console.warn(`  To suppress a file, add its path (relative to repo root) to scripts/.semantic-wrap-allow.txt.\n`);
}

if (interactive.length === 0) {
  console.log(`✔  check-semantic-wrap: no interactive components missing semantic instrumentation.`);
} else {
  console.warn(
    `\n⚠  check-semantic-wrap: ${interactive.length} interactive component(s) wire handlers but reference NO semantic wrapper.\n`,
  );
  for (const w of interactive) {
    console.warn(`  ${w.path}:${w.line}  (interactive prop: ${w.marker})`);
    console.warn(
      `    → This surface is invisible AND undrivable by the harness. Wrap it in a primitive or <Semantic>.`,
    );
    console.warn();
  }
  console.warn(`  To suppress a file, add its path (relative to repo root) to scripts/.semantic-wrap-allow.txt.\n`);
}

const total = warnings.length + interactive.length;
if (STRICT && total > 0) {
  console.error(`\n✖  check-semantic-wrap --strict: ${total} finding(s) — failing.\n`);
  process.exit(1);
}

// Default: warn-only, does not block CI.
process.exit(0);
