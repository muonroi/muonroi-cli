/**
 * codemod-harness-imports.ts
 *
 * Rewrites all imports that previously pointed into src/agent-harness/{moved-file}
 * or src/mcp/harness-driver to use @muonroi/agent-harness-core/* subpaths.
 *
 * Files that STAY in src/agent-harness/ (Phase 2) are NOT rewritten:
 *   semantic.tsx, reconciler-hook.ts, agent-mode.ts, input-bridge.tsx,
 *   test-spawn.ts, semantic-allowlist.ts (not present yet)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// Files moved to packages/agent-harness-core/src/ (no extension in patterns)
const MOVED_CORE = new Set(["protocol", "selector", "predicate", "driver", "mock-llm", "idle", "spec-helpers"]);

// Files that stay — do NOT rewrite these
const STAYS = new Set([
  "semantic",
  "reconciler-hook",
  "agent-mode",
  "input-bridge",
  "test-spawn",
  "semantic-allowlist",
]);

function getGlob() {
  const g = new Bun.Glob("**/*.{ts,tsx}");
  return g.scanSync({
    cwd: ROOT,
    absolute: true,
    onlyFiles: true,
    ignore: [
      "packages/**",
      "node_modules/**",
      "dist/**",
      ".muonroi-flow/**",
      "spikes/**",
      "scripts/codemod-harness-imports.ts", // self
    ],
  });
}

/**
 * Given an import specifier and the file that contains it, return the
 * canonical @muonroi/agent-harness-core subpath or null if not a moved file.
 */
function mapSpecifier(spec: string, fromFile: string): string | null {
  // --- Absolute / package-style specifiers ---

  // harness-driver → mcp-server
  if (spec.match(/(?:src\/)?mcp\/harness-driver(?:\.js)?$/)) {
    return "@muonroi/agent-harness-core/mcp-server";
  }

  // agent-harness/sidechannel → transports/sidechannel
  if (spec.match(/agent-harness\/sidechannel(?:\.js)?$/)) {
    return "@muonroi/agent-harness-core/transports/sidechannel";
  }

  // agent-harness/<moved-file>
  const coreMatch = spec.match(/agent-harness\/([^./]+?)(?:\.js)?$/);
  if (coreMatch) {
    const file = coreMatch[1]!;
    if (STAYS.has(file)) return null;
    if (MOVED_CORE.has(file)) {
      return `@muonroi/agent-harness-core/${file}`;
    }
  }

  // --- Relative specifiers: resolve to see if they point to a moved file ---
  if (spec.startsWith(".")) {
    const fileDir = dirname(fromFile);
    // Strip .js / .ts extension to get bare name
    const bare = spec.replace(/\.(js|ts|tsx)$/, "");
    const resolved = normalize(join(fileDir, bare));
    const relToRoot = resolved.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, "");

    // src/agent-harness/<file>
    const relMatch = relToRoot.match(/^src\/agent-harness\/([^/]+)$/);
    if (relMatch) {
      const file = relMatch[1]!;
      if (STAYS.has(file)) return null;
      if (file === "sidechannel") return "@muonroi/agent-harness-core/transports/sidechannel";
      if (MOVED_CORE.has(file)) return `@muonroi/agent-harness-core/${file}`;
    }

    // src/mcp/harness-driver
    if (relToRoot === "src/mcp/harness-driver") {
      return "@muonroi/agent-harness-core/mcp-server";
    }
  }

  return null;
}

function rewriteFile(filePath: string): number {
  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  let rewrites = 0;

  const rewritten = lines.map((line) => {
    const m = line.match(/^(\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?)(["'])([^"']+)(["'])(.*;\s*)$/);
    if (!m) return line;

    const prefix = m[1]!;
    const q1 = m[2]!;
    const spec = m[3]!;
    const q2 = m[4]!;
    const suffix = m[5]!;

    const mapped = mapSpecifier(spec, filePath);
    if (!mapped) return line;

    rewrites++;
    return `${prefix}${q1}${mapped}${q2}${suffix}`;
  });

  if (rewrites > 0) {
    writeFileSync(filePath, rewritten.join("\n"), "utf8");
  }

  return rewrites;
}

let totalFiles = 0;
let totalRewrites = 0;

for (const filePath of getGlob()) {
  const count = rewriteFile(filePath);
  if (count > 0) {
    totalFiles++;
    totalRewrites += count;
    console.log(`  rewritten (${count}): ${filePath.replace(ROOT, "")}`);
  }
}

console.log(`\nDone: ${totalRewrites} imports rewritten across ${totalFiles} files.`);
