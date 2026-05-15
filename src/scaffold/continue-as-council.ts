/**
 * continue-as-council.ts — Brainstorm-mode fallback for the halt recovery flow.
 *
 * When the user picks "Continue as council brainstorm" from the HaltRecoveryCard,
 * this scaffolder:
 *   1. Runs a lightweight council debate over the original prompt (or accepts a
 *      mock via the `runCouncil` injection point for testability).
 *   2. Collects all delta text into a spec.md skeleton.
 *   3. Writes spec.md to outputDir.
 *   4. Returns the spec path and a `hasContent` flag.
 *
 * IMPORTANT: This module does NOT call the verify gate, sprint-runner, or any
 * code path that would re-enter CB-3. Production council wiring is deferred per the
 * Task 5.5 decision recorded in the plan; the caller (app.tsx) emits a
 * "switch-to-council" event when the real orchestrator is available.
 */

import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContinueAsCouncilOptions {
  /** The original /ideal prompt the user issued. */
  prompt: string;
  /** Where to write spec.md. Defaults to process.cwd(). */
  outputDir?: string;
  /**
   * Inject the council runner for testability.
   * The real production caller wires this to src/council/index.ts runCouncil.
   * If omitted a no-op empty stream is used (results in hasContent: false).
   */
  runCouncil?: (prompt: string) => AsyncIterable<{ type: "delta" | "done"; content?: string }>;
  /** Inject filesystem ops for testability. */
  fs?: {
    writeFile: (p: string, content: string) => Promise<void>;
  };
}

export interface ContinueAsCouncilResult {
  /** Absolute path to the written spec.md */
  specPath: string;
  /** Whether the council produced any content. */
  hasContent: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run a council brainstorm and write the result to spec.md.
 *
 * Skips the verify gate, does NOT touch sprint-runner, does NOT re-enter CB-3.
 */
export async function continueAsCouncil(opts: ContinueAsCouncilOptions): Promise<ContinueAsCouncilResult> {
  const outputDir = opts.outputDir ?? process.cwd();
  const specPath = nodePath.resolve(outputDir, "spec.md");

  // ── Collect council delta text ──────────────────────────────────────────────
  let body = "";

  if (opts.runCouncil) {
    for await (const chunk of opts.runCouncil(opts.prompt)) {
      if (chunk.type === "delta" && chunk.content) {
        body += chunk.content;
      }
      if (chunk.type === "done") {
        break;
      }
    }
  }

  const hasContent = body.trim().length > 0;

  // ── Build spec.md skeleton ──────────────────────────────────────────────────
  const heading = `# Council brainstorm output\n\n**Prompt:** ${opts.prompt}\n\n`;
  const bodySection = hasContent
    ? `## Notes from council debate\n\n${body.trim()}\n`
    : `## Notes from council debate\n\n_(No content was produced by the council stream.)_\n`;

  const specContent = heading + bodySection;

  // ── Write spec.md ───────────────────────────────────────────────────────────
  const writeFile = opts.fs?.writeFile ?? defaultWriteFile;
  await writeFile(specPath, specContent);

  return { specPath, hasContent };
}

// ---------------------------------------------------------------------------
// Default fs helpers (swapped out in tests via opts.fs)
// ---------------------------------------------------------------------------

async function defaultWriteFile(p: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, content, "utf-8");
}
