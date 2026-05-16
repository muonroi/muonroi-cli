/**
 * bb-quality-gate.ts — Quality gate runner for BB-aware scaffold output.
 *
 * Tasks implemented:
 *   6.13 — Gate runner: dotnet restore + build + boundary script + sentinel grep
 *   6.14 — Retry-once via council on gate failure
 *   6.15 — Soft fallback: emit EE-GATE-FAILURES.md when retry still fails
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ContinueAsCouncilOptions } from "./continue-as-council.js";
import { continueAsCouncil } from "./continue-as-council.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GateStepFailure {
  step: string;
  output: string;
}

export interface GateResult {
  passed: boolean;
  failures: GateStepFailure[];
}

export interface BBQualityGateOptions {
  /** Root of the scaffolded server directory. */
  serverDir: string;
  /** Original user intent prompt (used in retry council call). */
  intentPrompt: string;
  /**
   * Inject exec for testability. Defaults to real spawnSync.
   * Receives (cmd, args, cwd) and returns { stdout, stderr, status }.
   */
  exec?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => { stdout: string; stderr: string; status: number | null };
  /**
   * Inject council runner for retry-once (task 6.14).
   * Defaults to continueAsCouncil with the failure appended.
   */
  runCouncil?: ContinueAsCouncilOptions["runCouncil"];
  /**
   * Inject writeFile for testability (task 6.15 fallback file).
   */
  writeFile?: (p: string, content: string) => void;
  /**
   * Inject fetchBBContext for remediation hints in EE-GATE-FAILURES.md.
   * When absent, fallback file is emitted without EE hints.
   */
  fetchBBContext?: (query: string) => Promise<{ behavioralRules: Array<{ text: string }> }>;
}

// ---------------------------------------------------------------------------
// Task 6.13 — Gate runner
// ---------------------------------------------------------------------------

const SENTINEL_OPEN = "// >>> muonroi-cli:injected:bb-ecosystem";

function defaultExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? (result.error ? 1 : 0),
  };
}

export async function runQualityGate(opts: BBQualityGateOptions): Promise<GateResult> {
  const { serverDir } = opts;
  const exec = opts.exec ?? defaultExec;
  const failures: GateStepFailure[] = [];

  // Step 1: dotnet restore (timeout 120s)
  const restore = exec("dotnet", ["restore", "--nologo"], serverDir, 120_000);
  if (restore.status !== 0) {
    failures.push({ step: "dotnet restore", output: `${restore.stdout}\n${restore.stderr}`.trim() });
  }

  // Step 2: dotnet build -c Debug --nologo (timeout 180s)
  const build = exec("dotnet", ["build", "-c", "Debug", "--nologo"], serverDir, 180_000);
  if (build.status !== 0) {
    failures.push({ step: "dotnet build", output: `${build.stdout}\n${build.stderr}`.trim() });
  }

  // Step 3: pwsh check-modular-boundaries.ps1 (timeout 30s)
  const scriptPath = path.join(serverDir, "scripts", "check-modular-boundaries.ps1");
  if ((opts.exec ? true : existsSync(scriptPath))) {
    const boundary = exec("pwsh", [scriptPath, "-RepoRoot", "."], serverDir, 30_000);
    if (boundary.status !== 0) {
      failures.push({ step: "check-modular-boundaries", output: `${boundary.stdout}\n${boundary.stderr}`.trim() });
    }
  }

  // Step 4: Sentinel grep — verify injected block present
  const programCs = path.join(serverDir, "Program.cs");
  if (opts.exec ? true : existsSync(programCs)) {
    const grep = exec(
      "pwsh",
      ["-Command", `Select-String -Path '${programCs}' -Pattern '${SENTINEL_OPEN}' -Quiet`],
      serverDir,
      5_000,
    );
    if (grep.status !== 0) {
      failures.push({
        step: "sentinel-check",
        output: `BB ecosystem sentinel block not found in Program.cs. Expected: ${SENTINEL_OPEN}`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Task 6.14 — Retry-once on failure
// ---------------------------------------------------------------------------

export async function runQualityGateWithRetry(
  opts: BBQualityGateOptions,
  onRetryCodeGen?: () => Promise<void>,
): Promise<GateResult> {
  const firstResult = await runQualityGate(opts);
  if (firstResult.passed) return firstResult;

  // Build failure summary for council
  const failureSummary = firstResult.failures
    .map((f) => `### ${f.step}\n\`\`\`\n${f.output.slice(0, 500)}\n\`\`\``)
    .join("\n\n");

  const councilPrompt = `${opts.intentPrompt}

## Gate failures (please fix in next iteration)
${failureSummary}

Please revise the BB ecosystem wiring to fix these compilation/boundary errors.`;

  // Call council once with failures appended
  await continueAsCouncil({
    prompt: councilPrompt,
    outputDir: opts.serverDir,
    runCouncil: opts.runCouncil,
  });

  // Re-run code-gen if callback provided
  if (onRetryCodeGen) {
    await onRetryCodeGen();
  }

  // Run gate again
  return runQualityGate(opts);
}

// ---------------------------------------------------------------------------
// Task 6.15 — Soft fallback: emit EE-GATE-FAILURES.md
// ---------------------------------------------------------------------------

export async function emitGateFailuresFallback(opts: {
  serverDir: string;
  failures: GateStepFailure[];
  fetchBBContext?: BBQualityGateOptions["fetchBBContext"];
  writeFile?: (p: string, content: string) => void;
}): Promise<void> {
  const { serverDir, failures } = opts;
  const writeFileFn = opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));

  const lines: string[] = [
    "# EE-GATE-FAILURES.md",
    "",
    `Generated by muonroi-cli on ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "## Gate Failures",
    "",
  ];

  for (const f of failures) {
    lines.push(`### ${f.step}`);
    lines.push("```");
    lines.push(f.output.slice(0, 1000));
    lines.push("```");
    lines.push("");

    // Task 6.15 — fetch remediation hints from EE behavioral rules
    if (opts.fetchBBContext) {
      try {
        // Extract key error keywords from stderr (first 200 chars of output)
        const keywords = f.output.slice(0, 200).replace(/[^\w\s]/g, " ").trim();
        const ctx = await opts.fetchBBContext(keywords);
        if (ctx.behavioralRules.length > 0) {
          lines.push("**Remediation hints from EE:**");
          for (const rule of ctx.behavioralRules.slice(0, 3)) {
            lines.push(`- ${rule.text.slice(0, 200)}`);
          }
          lines.push("");
        }
      } catch {
        // EE unavailable — skip hints
      }
    }
  }

  lines.push("## Next steps");
  lines.push("");
  lines.push("Run `/ideal --resume .` to attempt interactive fixes.");
  lines.push("");
  lines.push("Or fix manually and re-run:");
  lines.push("```");
  lines.push("dotnet restore && dotnet build -c Debug --nologo");
  lines.push("pwsh ./scripts/check-modular-boundaries.ps1 -RepoRoot .");
  lines.push("```");

  const outPath = path.join(serverDir, "EE-GATE-FAILURES.md");
  writeFileFn(outPath, lines.join("\n"));

  process.stdout.write(
    `⚠️ Scaffold complete with ${failures.length} gate failure(s) — see EE-GATE-FAILURES.md. Run /ideal --resume to attempt fixes interactively.\n`,
  );
}

// ---------------------------------------------------------------------------
// Convenience: run gate + retry + soft fallback in one call
// ---------------------------------------------------------------------------

export async function runGatePipeline(
  opts: BBQualityGateOptions,
  onRetryCodeGen?: () => Promise<void>,
): Promise<GateResult> {
  const result = await runQualityGateWithRetry(opts, onRetryCodeGen);

  if (!result.passed) {
    await emitGateFailuresFallback({
      serverDir: opts.serverDir,
      failures: result.failures,
      fetchBBContext: opts.fetchBBContext,
      writeFile: opts.writeFile,
    });
  }

  return result;
}
