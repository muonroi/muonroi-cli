/**
 * pr-builder.ts — P16 PR mode output for Mode C (maintenance).
 *
 * Computes a unified diff from git, flags files outside the declared impact
 * radius, generates a PR title + body via a single LLM call, and squashes
 * agent commits down to one if a pre-edit marker SHA exists.
 *
 * Hard rules:
 *   - No shell:true in child_process. All git calls via execFile + argv arrays.
 *   - No hardcoded model IDs. All LLM routing via pickCouncilTaskModel.
 *   - No filesystem writes except os.tmpdir (body temp file is handled in gh-create-pr).
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { pickCouncilTaskModel } from "../council/leader.js";
import type { MaintenanceTaskResult } from "./task-runner.js";
import type { CodebaseIntel, MaintenanceTask } from "./types.js";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface CouncilLLM {
  generate(modelId: string, system: string, prompt: string, maxTokens?: number): Promise<string>;
}

export interface BuildPrInput {
  task: MaintenanceTask;
  codebaseIntel: CodebaseIntel;
  result: MaintenanceTaskResult;
  cwd: string;
  leaderModelId: string;
  costAware: boolean;
  llm: CouncilLLM;
}

export interface BuildPrOutput {
  branch: string;
  title: string;
  body: string;
  diff: string;
  changedFiles: string[];
  filesOutsideRadius: string[];
}

// ─── Branch name sanitisation ─────────────────────────────────────────────────

const SAFE_BRANCH_RE = /^[a-z0-9/_-]+$/;

function toBranchSafe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Git helpers (no shell:true) ──────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
  const execFile = promisify(childProcess.execFile);
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf-8" });
  return (stdout ?? "").trim();
}

/** Like git() but returns stdout WITHOUT trimming (needed for porcelain output). */
async function gitRaw(cwd: string, ...args: string[]): Promise<string> {
  const execFile = promisify(childProcess.execFile);
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf-8" });
  return stdout ?? "";
}

async function gitSafe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

async function gitRawSafe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await gitRaw(cwd, ...args);
  } catch {
    return null;
  }
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await gitSafe(cwd, "rev-parse", "--verify", branch);
  return result !== null;
}

async function uniqueBranchName(cwd: string, base: string): Promise<string> {
  if (!(await branchExists(cwd, base))) return base;
  for (let i = 2; i <= 10; i++) {
    const candidate = `${base}-${i}`;
    if (!(await branchExists(cwd, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ─── Changed files helpers ────────────────────────────────────────────────────

async function getChangedFiles(cwd: string, squashed: boolean, markerSha: string | null): Promise<string[]> {
  const results = new Set<string>();

  // Unstaged + staged changes.
  // Porcelain v1 format: "XY filename" where XY are exactly 2 status chars + 1 space.
  // Use gitRaw (no trim) so leading status chars are preserved on each line.
  const porcelain = await gitRawSafe(cwd, "status", "--porcelain");
  if (porcelain) {
    for (const line of porcelain.split("\n")) {
      if (line.length <= 3) continue;
      // First 2 chars = status flags, 3rd = space, rest = path.
      const filePath = line.slice(3).trim();
      if (filePath) results.add(filePath);
    }
  }

  // Committed changes: HEAD~1 vs HEAD after squash, or marker vs HEAD when no squash
  if (squashed) {
    const diffNames = await gitSafe(cwd, "diff", "--name-only", "HEAD~1", "HEAD");
    if (diffNames) {
      for (const f of diffNames.split("\n")) {
        const t = f.trim();
        if (t) results.add(t);
      }
    }
  } else if (markerSha) {
    const diffNames = await gitSafe(cwd, "diff", "--name-only", markerSha, "HEAD");
    if (diffNames) {
      for (const f of diffNames.split("\n")) {
        const t = f.trim();
        if (t) results.add(t);
      }
    }
  }

  return Array.from(results).filter(Boolean);
}

// ─── Impact radius check ──────────────────────────────────────────────────────

function findFilesOutsideRadius(changedFiles: string[], intel: CodebaseIntel): string[] {
  const inRadius = new Set<string>();
  for (const cf of intel.candidateFiles) inRadius.add(cf.path);
  for (const f of intel.impactRadius) inRadius.add(f);
  for (const f of intel.regressionTests) inRadius.add(f);

  return changedFiles.filter((f) => !inRadius.has(f));
}

// ─── Diff computation ─────────────────────────────────────────────────────────

async function computeDiff(cwd: string, squashed: boolean, markerSha: string | null): Promise<string> {
  let diffOut: string | null = null;

  if (squashed) {
    diffOut = await gitSafe(cwd, "diff", "HEAD~1", "HEAD");
  } else if (markerSha) {
    diffOut = await gitSafe(cwd, "diff", markerSha, "HEAD");
  }

  // Fall back to current working-tree diff
  if (!diffOut) {
    diffOut = await gitSafe(cwd, "diff", "HEAD");
  }

  return diffOut ?? "";
}

// ─── Marker SHA reader ────────────────────────────────────────────────────────

function readMarkerSha(runId: string, cwd: string): string | null {
  // Marker is written by P15 (pending follow-up patch). If file exists, use it.
  const candidatePaths = [
    path.join(cwd, ".planning", "runs", runId, "pre-edit-marker.sha"),
    path.join(cwd, ".planning", "runs", runId, "pre-edit-marker.sha".replace("/", path.sep)),
  ];

  for (const p of candidatePaths) {
    try {
      const content = fs.readFileSync(p, "utf-8").trim();
      if (content.length >= 7) return content;
    } catch {
      // File doesn't exist — that's fine.
    }
  }

  return null;
}

// ─── Squash helper ────────────────────────────────────────────────────────────

/**
 * Squash all commits since markerSha down to a single commit with the PR title.
 * Returns true on success, false on graceful degrade (no-op).
 *
 * IMPORTANT: this function MUST wrap any git mutation in try/catch and return
 * false rather than throwing — squash failure is non-fatal per D3.
 */
async function squashSinceMarker(cwd: string, markerSha: string, title: string): Promise<boolean> {
  try {
    // Verify HEAD exists.
    const head = await gitSafe(cwd, "rev-parse", "HEAD");
    if (!head) return false;

    // If HEAD is already the marker, nothing to squash.
    if (head === markerSha) return false;

    // Check we have at least one commit since the marker.
    const log = await gitSafe(cwd, "log", "--oneline", `${markerSha}..HEAD`);
    if (!log || log.trim() === "") return false;

    await git(cwd, "reset", "--soft", markerSha);

    // Build commit message: first 72 chars as subject, full title as body if longer.
    const subject = title.length <= 72 ? title : `${title.slice(0, 71)}…`;
    const body = title.length > 72 ? `\n\n${title}` : "";
    const message = `${subject}${body}`;

    await git(cwd, "commit", "-m", message);
    return true;
  } catch {
    // Graceful degrade — log not exposed but no throw.
    return false;
  }
}

// ─── PR body prompt ───────────────────────────────────────────────────────────

const PR_BODY_SYSTEM =
  "You are a senior engineer writing the description for your own pull request. " +
  "Write for a busy reviewer: they should understand what this PR does, why it exists, and how to verify it " +
  "within thirty seconds of reading — before they open a single file. " +
  "Write in plain, confident prose. Prefer specific claims ('caps retry backoff at 30s') over vague ones " +
  "('improves retry handling'). Never restate filenames or diffs mechanically — explain intent and effect. " +
  "Do not pad, do not apologize, and do not invent changes that are not evidenced by the task data or diff. " +
  "Output ONLY the finished markdown body — no preamble, no commentary, and no code fence wrapping the whole output.";

function buildPrBodyPrompt(
  task: MaintenanceTask,
  diff: string,
  intel: CodebaseIntel,
  result: MaintenanceTaskResult,
  filesOutsideRadius: string[],
): string {
  const diffSnippet = diff.length > 8192 ? `${diff.slice(0, 8192)}\n...[diff truncated to 8KB]` : diff;

  const descriptionSummary = task.description.length > 600 ? `${task.description.slice(0, 597)}…` : task.description;

  const outsideSection =
    filesOutsideRadius.length > 0
      ? `\n## Files outside declared impact radius\n${filesOutsideRadius.map((f) => `- ${f}`).join("\n")}`
      : "";

  const concernsSection =
    result.reviewConcerns.length > 0
      ? `\n## Review Concerns\n${result.reviewConcerns.map((c) => `- ${c}`).join("\n")}`
      : "";

  return [
    "Write the pull request body for the maintenance task below.",
    "Use exactly the section structure described here, in this order. Render real content for every section — no placeholders, no angle brackets in the output.",
    "Output ONLY the rendered markdown body — nothing else.",
    "",
    "## Structure",
    "---",
    "## Summary",
    "Two to four sentences a reviewer can read in isolation: what problem this PR solves, why it matters now, and the shape of the fix. Ground it in the task description, but rewrite it as prose — do not paste the task text verbatim.",
    "",
    "## What changed",
    "Three to six bullets describing observable behavior changes, ordered most-significant first. Each bullet states an effect ('X now does Y', 'Z no longer happens when W'), not a file operation. Infer these from the diff hunks; mention a file path only when it clarifies scope. If the diff is trivially small, two bullets are fine — do not pad.",
    "",
    "## Test plan",
    "One bullet per acceptance criterion, phrased as a verifiable check the reviewer could repeat. Then list the regression tests that were run. If something was NOT verified, say so plainly rather than omitting it.",
    outsideSection ? "## Files outside declared impact radius" : "",
    outsideSection
      ? "List each file from the task data below, and for each add a short honest note on why it was touched (or 'reason unclear from diff' if you cannot tell). These files deserve extra reviewer scrutiny — do not downplay them."
      : "",
    concernsSection ? "## Review Concerns" : "",
    concernsSection
      ? "List each concern from the task data verbatim, one bullet each. These are non-blocking flags for reviewer awareness — preserve their meaning, do not soften or editorialize."
      : "",
    "## Related",
    "- Impact radius: the first 5 entries from the impact radius in the task data",
    "- Regression tests run: the first 5 entries from the regression tests in the task data",
    "---",
    "",
    "Rules: British understatement over marketing tone. No emoji. No headers beyond those specified. Keep the whole body under ~350 words unless the concerns/outside-radius sections force it longer.",
    "",
    "## Task data",
    `Kind: ${task.kind}`,
    `Title: ${task.title}`,
    `Description: ${descriptionSummary}`,
    `Acceptance criteria:`,
    task.acceptance_criteria.map((c) => `  - ${c}`).join("\n"),
    `Impact radius: ${intel.impactRadius.slice(0, 5).join(", ") || "none"}`,
    `Regression tests: ${intel.regressionTests.slice(0, 5).join(", ") || "none"}`,
    filesOutsideRadius.length > 0 ? `Files outside radius: ${filesOutsideRadius.join(", ")}` : "",
    result.reviewConcerns.length > 0
      ? `Review concerns:\n${result.reviewConcerns.map((c) => `  - ${c}`).join("\n")}`
      : "",
    "",
    "## Diff",
    diffSnippet,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function buildPr(input: BuildPrInput): Promise<BuildPrOutput> {
  const { task, codebaseIntel, result, cwd, leaderModelId, costAware, llm } = input;

  // 1. Title: first 72 chars of task.title, truncate with … if needed.
  const rawTitle = task.title.split("\n")[0]?.trim() ?? task.title;
  const title = rawTitle.length <= 72 ? rawTitle : `${rawTitle.slice(0, 71)}…`;

  // 2. Read marker SHA (written by P15 — may not exist yet).
  const markerSha = readMarkerSha(task.id, cwd);

  // 3. Squash commits if marker exists.
  let squashed = false;
  if (markerSha) {
    squashed = await squashSinceMarker(cwd, markerSha, title);
  }

  // 4. Compute changed files (union of status + diff --name-only).
  const changedFiles = await getChangedFiles(cwd, squashed, markerSha);

  // 5. Impact radius check.
  const filesOutsideRadius = findFilesOutsideRadius(changedFiles, codebaseIntel);

  // 6. Compute diff.
  const diff = await computeDiff(cwd, squashed, markerSha);

  // 7. Compute branch name.
  const kindSafe = toBranchSafe(task.kind);
  const idShort = task.id
    .slice(0, 8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const baseBranch = `claude/${kindSafe}-${idShort}`;
  if (!SAFE_BRANCH_RE.test(baseBranch)) {
    throw new Error(`Generated branch name is not safe: ${baseBranch}`);
  }
  const branch = await uniqueBranchName(cwd, baseBranch);

  // 8. Generate PR body via LLM (single call, tier=fast via pr_body tag).
  const prBodyModelId = pickCouncilTaskModel("pr_body", leaderModelId, costAware);
  const bodyPrompt = buildPrBodyPrompt(task, diff, codebaseIntel, result, filesOutsideRadius);
  let body: string;
  try {
    body = await llm.generate(prBodyModelId, PR_BODY_SYSTEM, bodyPrompt, 1024);
  } catch (err) {
    // Non-fatal — produce a minimal fallback body.
    const msg = err instanceof Error ? err.message : String(err);
    body = [
      "## Summary",
      task.description.slice(0, 300),
      "",
      "## What changed",
      "_(LLM body generation failed — see diff below)_",
      `Error: ${msg}`,
      "",
      "## Test plan",
      task.acceptance_criteria.map((c) => `- ${c}`).join("\n"),
    ].join("\n");
  }

  return {
    branch,
    title,
    body,
    diff,
    changedFiles,
    filesOutsideRadius,
  };
}
