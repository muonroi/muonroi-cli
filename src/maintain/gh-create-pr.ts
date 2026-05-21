/**
 * gh-create-pr.ts — P16 optional gh CLI wrapper for creating a GitHub PR.
 *
 * Decision D2 (MAINTAIN-MODE.md): PR auto-create is OFF by default.
 * This module runs ONLY when the caller passes --gh-pr and explicitly opts in.
 *
 * Hard rules:
 *   - No shell:true in execFile calls. Explicit argv arrays only.
 *   - Branch names validated against /^[a-z0-9/_-]+$/ before use.
 *   - No hardcoded model IDs or providers in this file.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface GhCreatePrInput {
  branch: string;
  title: string;
  body: string;
  cwd: string;
  baseBranch?: string; // default: auto-detect from `gh repo view`, fallback "main"
}

export interface GhCreatePrOutput {
  ok: boolean;
  url?: string;
  reason?: string;
}

// ─── Branch name guard ────────────────────────────────────────────────────────

const SAFE_BRANCH_RE = /^[a-z0-9/_-]+$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function run(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const execFile = promisify(childProcess.execFile);
  try {
    const { stdout, stderr } = await execFile(cmd, args, { cwd, encoding: "utf-8" });
    return { stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim(), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
      ok: false,
    };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function ghCreatePr(input: GhCreatePrInput): Promise<GhCreatePrOutput> {
  const { branch, title, body, cwd } = input;

  // Validate branch name before any git/gh interaction.
  if (!SAFE_BRANCH_RE.test(branch)) {
    return {
      ok: false,
      reason: `branch name contains invalid characters: ${branch} (must match /^[a-z0-9/_-]+$/)`,
    };
  }

  // Step 1: Check gh CLI is installed.
  const ghVersion = await run("gh", ["--version"], cwd);
  if (!ghVersion.ok) {
    return { ok: false, reason: "gh CLI not installed — install from https://cli.github.com" };
  }

  // Step 2: Check gh auth status.
  const authStatus = await run("gh", ["auth", "status"], cwd);
  if (!authStatus.ok) {
    return { ok: false, reason: "gh not authenticated — run 'gh auth login' first" };
  }

  // Step 3: Create or switch to the branch, then push.
  // Check if branch already exists locally.
  const branchCheck = await run("git", ["rev-parse", "--verify", branch], cwd);
  if (branchCheck.ok) {
    // Branch exists — switch to it.
    const checkout = await run("git", ["checkout", branch], cwd);
    if (!checkout.ok) {
      return { ok: false, reason: `git checkout ${branch} failed: ${checkout.stderr}` };
    }
  } else {
    // Create new branch.
    const checkoutNew = await run("git", ["checkout", "-b", branch], cwd);
    if (!checkoutNew.ok) {
      return { ok: false, reason: `git checkout -b ${branch} failed: ${checkoutNew.stderr}` };
    }
  }

  // Push branch to origin with tracking.
  const push = await run("git", ["push", "-u", "origin", branch], cwd);
  if (!push.ok) {
    return { ok: false, reason: `git push failed: ${push.stderr}` };
  }

  // Step 4: Determine base branch.
  let baseBranch = input.baseBranch;
  if (!baseBranch) {
    const defaultBranchResult = await run(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      cwd,
    );
    baseBranch = defaultBranchResult.ok && defaultBranchResult.stdout ? defaultBranchResult.stdout : "main";
  }

  // Step 5: Write body to a temp file — gh expects --body-file for multiline bodies.
  const tmpFile = path.join(os.tmpdir(), `pr-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  let tmpWritten = false;
  try {
    fs.writeFileSync(tmpFile, body, "utf-8");
    tmpWritten = true;

    // Step 6: Run gh pr create.
    const pr = await run(
      "gh",
      ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", tmpFile],
      cwd,
    );

    if (!pr.ok) {
      return { ok: false, reason: pr.stderr || "gh pr create failed" };
    }

    // stdout should contain the PR URL.
    const urlMatch = pr.stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : pr.stdout;

    return { ok: true, url };
  } finally {
    // Step 7: Clean up temp file.
    if (tmpWritten) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Non-fatal — temp file cleanup failure is ignored.
      }
    }
  }
}
