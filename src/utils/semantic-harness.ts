/**
 * src/utils/semantic-harness.ts
 *
 * Does this workspace carry a Semantic-instrumented TUI that self-verify can
 * drive? The selfverify_* tools spawn THIS CLI's TUI (self-qa/runtime-paths.ts
 * SELF_QA_ENTRY) and plan scenarios only from `<Semantic id=…>` wrappers found
 * in the workspace's changed .tsx files (self-qa/scenario-planner.ts
 * SEMANTIC_RE). Those wrappers come from `@muonroi/agent-harness-opentui`
 * (`import { Semantic } from "@muonroi/agent-harness-opentui"` across src/ui).
 * A workspace that neither ships nor depends on that package can never yield a
 * scenario, so registering the tools there only advertises a capability that
 * cannot apply (measured: tcis-libraries, a .NET repo, was offered all five).
 *
 * Detection walks from cwd up to the git root (or the filesystem root) and
 * accepts the first directory that either
 *   - contains the package source (`packages/agent-harness-opentui/package.json`
 *     — muonroi-cli's own workspace layout), or
 *   - has it installed (`node_modules/@muonroi/agent-harness-opentui/package.json`), or
 *   - declares it in package.json (dependencies / devDependencies / peerDependencies).
 * Pure fs, a handful of existsSync calls, memoised per cwd.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "./logger.js";

export const SEMANTIC_HARNESS_PACKAGE = "@muonroi/agent-harness-opentui";

const cache = new Map<string, boolean>();

function declaresHarness(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies", "peerDependencies"].some(
      (field) => typeof pkg[field]?.[SEMANTIC_HARNESS_PACKAGE] === "string",
    );
  } catch (err) {
    logger.file("warn", "cli", "semantic-harness: unreadable package.json", {
      manifest,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function hasSemanticHarness(cwd: string): boolean {
  const start = resolve(cwd);
  const hit = cache.get(start);
  if (hit !== undefined) return hit;
  let found = false;
  for (let dir = start; ; ) {
    if (
      existsSync(join(dir, "packages", "agent-harness-opentui", "package.json")) ||
      existsSync(join(dir, "node_modules", "@muonroi", "agent-harness-opentui", "package.json")) ||
      declaresHarness(dir)
    ) {
      found = true;
      break;
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  cache.set(start, found);
  return found;
}

/** Test helper — forget memoised answers. */
export function _resetSemanticHarnessCache(): void {
  cache.clear();
}
