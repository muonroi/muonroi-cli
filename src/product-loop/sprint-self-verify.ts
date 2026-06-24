/**
 * src/product-loop/sprint-self-verify.ts
 *
 * Tier 3 — sprint pipeline integration of the self-QA harness.
 *
 * After the verification stage passes (recipe verdict = PASS), if the sprint
 * touched UI / harness watched surfaces, spawn Tier 1 self-verify to catch
 * lifecycle / modal / focus bugs that vitest cannot see. Result is ADDITIVE:
 * a self-verify failure downgrades the sprint verdict to FAIL so the loop
 * iterates again with the failure context in the carryOver feedback.
 *
 * Default OFF — opt-in via MUONROI_SPRINT_SELF_VERIFY=1. Off keeps the sprint
 * loop fast and avoids the ~30s tax on every iteration during /ideal runs.
 *
 * Hook point: `src/product-loop/sprint-runner.ts` ~ line 425 (after
 * `parseVerifyResult` if verdict === "PASS"). See CLAUDE.md §Tier 3 doc.
 */

import { execSync, spawnSync } from "node:child_process";
import * as path from "node:path";

/** Watched surfaces — must mirror `scripts/self-verify-pre-push.cjs` WATCH_DIRS. */
const WATCH_DIRS = ["src/ui/", "src/self-qa/", "src/agent-harness/", "packages/agent-harness-"];

export interface SprintSelfVerifyResult {
  ran: boolean;
  /** Reason the verifier did not run, when `ran === false`. */
  skipReason?: "disabled" | "no-watched-changes" | "no-baseref" | "spawn-failed";
  /** Verdict from self-verify when `ran === true`. */
  verdict?: "pass" | "fail" | "inconclusive";
  /** Markdown-formatted detail for inclusion in sprint feedback / verifyResult.error. */
  detail?: string;
  /** Wall-clock elapsed in ms. */
  elapsedMs?: number;
}

export interface SprintSelfVerifyOpts {
  /** Project root — used as cwd for git and the self-verify spawn. */
  repoRoot: string;
  /**
   * Git ref to diff HEAD against. Typical caller passes `ctx.baseRef` or
   * falls back to `origin/master`. When undefined, falls back to `HEAD~1`
   * so a single-commit sprint still gets coverage.
   */
  baseRef?: string;
  /** Max scenarios for the Tier 1 heuristic run. Defaults to 4. */
  maxScenarios?: number;
  /** Timeout for the self-verify child. Defaults to 90s. */
  timeoutMs?: number;
  /**
   * Optional override for the env-var gate. Tests pass `true` to bypass the
   * default-off behaviour without setting process.env.
   */
  forceEnable?: boolean;
}

/**
 * Default ON for local dev — only OFF when running in CI or when the developer
 * explicitly disables via MUONROI_SPRINT_SELF_VERIFY=0. Rationale: Tier 1 is
 * fast (~30s) and cheap (<$0.01) and catches the most common UI regressions.
 * Off-by-default leaks the gate; on-by-default makes it impossible to forget.
 *
 * CI gets OFF to avoid the ~30s tax on every sprint when nightly /ideal runs
 * generate many iterations.
 */
function isEnabled(forceEnable?: boolean): boolean {
  if (forceEnable === true) return true;
  const v = process.env.MUONROI_SPRINT_SELF_VERIFY;
  if (v === "0" || (v && v.toLowerCase() === "false")) return false;
  if (process.env.CI === "true" || process.env.NODE_ENV === "ci") return false;
  // Default: ON. v === "1"/"true" still works; absence of env var also enables.
  return true;
}

function detectTouchedWatched(repoRoot: string, baseRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => WATCH_DIRS.some((d) => f.startsWith(d)));
  } catch {
    return [];
  }
}

/**
 * Spawn `bun run src/index.ts self-verify --since <baseRef> --max <n> --no-emit --json`
 * and parse the trailing JSON summary line.
 *
 * Returns the parsed verdict plus elapsed ms. Crash / timeout = inconclusive.
 */
export async function runSprintSelfVerify(opts: SprintSelfVerifyOpts): Promise<SprintSelfVerifyResult> {
  const t0 = Date.now();

  if (!isEnabled(opts.forceEnable)) {
    return { ran: false, skipReason: "disabled" };
  }

  const baseRef = opts.baseRef ?? "HEAD~1";
  const repoRoot = opts.repoRoot;

  const touched = detectTouchedWatched(repoRoot, baseRef);
  if (touched.length === 0) {
    return { ran: false, skipReason: "no-watched-changes" };
  }

  const max = String(opts.maxScenarios ?? 4);
  const entry = path.join(repoRoot, "src", "index.ts");
  const result = spawnSync(
    "bun",
    ["run", entry, "self-verify", "--since", baseRef, "--max", max, "--no-emit", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 90_000,
      shell: process.platform === "win32",
    },
  );

  if (result.error || result.status === null) {
    return {
      ran: false,
      skipReason: "spawn-failed",
      detail: `self-verify spawn failed: ${result.error?.message ?? "unknown"}`,
      elapsedMs: Date.now() - t0,
    };
  }

  // In --json mode the CLI silences all log() output and prints a single
  // pretty-printed report JSON. Parse the whole stdout, then read .summary.
  let report: { summary?: { passed?: number; failed?: number; inconclusive?: number; total?: number } } | null = null;
  try {
    const raw = (result.stdout ?? "").trim();
    if (raw.startsWith("{")) report = JSON.parse(raw);
  } catch {
    /* fall through to inconclusive */
  }
  const summary = report?.summary ?? null;

  const elapsedMs = Date.now() - t0;
  if (!summary) {
    return {
      ran: true,
      verdict: "inconclusive",
      detail: `self-verify produced no parseable JSON summary (exit ${result.status})`,
      elapsedMs,
    };
  }

  const failed = summary.failed ?? 0;
  const passed = summary.passed ?? 0;
  const inconc = summary.inconclusive ?? 0;
  const total = summary.total ?? failed + passed + inconc;

  if (failed > 0) {
    return {
      ran: true,
      verdict: "fail",
      detail: [
        `Self-verify Tier 1 reported ${failed}/${total} scenario(s) FAILED on watched UI / harness surfaces.`,
        `Touched files (${touched.length}):`,
        ...touched.slice(0, 8).map((f) => `  - ${f}`),
        touched.length > 8 ? `  (+${touched.length - 8} more)` : "",
        "",
        "Action: re-run with --agentic to capture richer goal/actual mismatch, then update the implementation.",
        "Override (NOT recommended) to ignore this gate: MUONROI_SPRINT_SELF_VERIFY=0.",
      ]
        .filter(Boolean)
        .join("\n"),
      elapsedMs,
    };
  }

  if (passed > 0 && inconc === 0) {
    return { ran: true, verdict: "pass", elapsedMs };
  }
  return {
    ran: true,
    verdict: "inconclusive",
    detail: `Self-verify Tier 1: ${passed}/${total} passed, ${inconc} inconclusive — no hard failures.`,
    elapsedMs,
  };
}
