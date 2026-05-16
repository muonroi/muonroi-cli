/**
 * resume-from-gate-failures.ts — /ideal --resume <project-path> handler.
 *
 * Task 6.16:
 *   Detects EE-GATE-FAILURES.md at the given project path.
 *   Loads failure context + re-enters CB-1 via existing runSprint machinery.
 *
 * NOTE: point-to-existing.ts is used ONLY for path validation.
 * CB-1 re-entry + context loading are implemented here from scratch.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ContinueAsCouncilOptions } from "./continue-as-council.js";
import { continueAsCouncil } from "./continue-as-council.js";
import { pointToExisting } from "./point-to-existing.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResumeFromGateFailuresOptions {
  /**
   * Path to the project directory containing EE-GATE-FAILURES.md.
   * May be absolute or relative.
   */
  projectPath: string;
  /**
   * Inject council runner (for testability).
   * Defaults to continueAsCouncil with no-op stream.
   */
  runCouncil?: ContinueAsCouncilOptions["runCouncil"];
  /**
   * Inject fs ops for testability.
   */
  fs?: {
    exists: (p: string) => boolean;
    readFile: (p: string) => string;
  };
  /**
   * Inject detectVerifyRecipe for path validation via point-to-existing.
   */
  detectVerifyRecipe?: (cwd: string) => Promise<unknown | null>;
}

export interface ResumeResult {
  ok: boolean;
  reason: "no_gate_failures_file" | "invalid_path" | "resumed" | "error";
  specPath?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * /ideal --resume <project-path>
 *
 * 1. Validates the path via point-to-existing (path validation only).
 * 2. Loads EE-GATE-FAILURES.md content.
 * 3. Re-enters CB-1 via continueAsCouncil with failures as initial prompt.
 */
export async function resumeFromGateFailures(opts: ResumeFromGateFailuresOptions): Promise<ResumeResult> {
  const fsOps = opts.fs ?? {
    exists: (p: string) => existsSync(p),
    readFile: (p: string) => readFileSync(p, "utf-8"),
  };

  // Step 1: validate path using point-to-existing (path validation only)
  const detectRecipe = opts.detectVerifyRecipe ?? (() => Promise.resolve(null));
  const pathResult = await pointToExisting({ path: opts.projectPath, detectVerifyRecipe: detectRecipe });

  if (!pathResult.ok) {
    return { ok: false, reason: "invalid_path", error: `Path validation failed: ${pathResult.reason}` };
  }

  const absolutePath = pathResult.absolutePath;

  // Step 2: detect EE-GATE-FAILURES.md
  const gateFailuresPath = path.join(absolutePath, "EE-GATE-FAILURES.md");
  if (!fsOps.exists(gateFailuresPath)) {
    return {
      ok: false,
      reason: "no_gate_failures_file",
      error: `No EE-GATE-FAILURES.md found at ${absolutePath}`,
    };
  }

  // Step 3: load failure context
  let failuresContent: string;
  try {
    failuresContent = fsOps.readFile(gateFailuresPath);
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      error: `Failed to read EE-GATE-FAILURES.md: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Also load EE-INTENT.md if present for original intent context
  const intentPath = path.join(absolutePath, "EE-INTENT.md");
  let intentContent = "";
  if (fsOps.exists(intentPath)) {
    try {
      intentContent = fsOps.readFile(intentPath);
    } catch {
      // Non-fatal — proceed without it
    }
  }

  // Step 4: Re-enter CB-1 via continueAsCouncil with failure context
  const resumePrompt = buildResumePrompt(failuresContent, intentContent);

  try {
    const councilResult = await continueAsCouncil({
      prompt: resumePrompt,
      outputDir: absolutePath,
      runCouncil: opts.runCouncil,
    });

    return { ok: true, reason: "resumed", specPath: councilResult.specPath };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      error: `Council re-entry failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResumePrompt(failuresContent: string, intentContent: string): string {
  const sections: string[] = [
    "# /ideal --resume: Fix gate failures",
    "",
    "The previous scaffold run produced gate failures. Please analyze them and provide",
    "corrected BB ecosystem wiring (Program.cs, Directory.Packages.props, etc.).",
    "",
  ];

  if (intentContent) {
    sections.push("## Original Intent");
    sections.push("");
    sections.push(intentContent.slice(0, 800));
    sections.push("");
  }

  sections.push("## Gate Failures to Fix");
  sections.push("");
  sections.push(failuresContent.slice(0, 2000));
  sections.push("");
  sections.push("## Instructions");
  sections.push("");
  sections.push(
    "1. Identify root cause of each failure from the output above.",
    "2. Suggest specific code changes to Program.cs or Directory.Packages.props.",
    "3. If boundary violations: list which packages to remove or replace with OSS alternatives.",
    "4. Output a revised scaffold plan that will pass the quality gate.",
  );

  return sections.join("\n");
}
