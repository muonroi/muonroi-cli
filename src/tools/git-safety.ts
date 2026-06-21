/**
 * src/tools/git-safety.ts
 *
 * Pre-execution git safety for the bash tool. Distilled from a real session
 * audit (18285908637a) where a cheap model:
 *   1. pushed while 24 tests were failing (it batched `git add -A && commit &&
 *      push` in the SAME tool batch as the test run, so push was never gated
 *      on the result), and
 *   2. swept the CLI's own `.muonroi-cli/settings.json` (which can hold
 *      provider API keys) into a public repo via `git add -A`.
 *
 * Two guards, both cheap and side-effect-free:
 *   - PUSH GATE: a session-scoped record of failed verification commands
 *     (test/build/lint/typecheck). A `git push` is BLOCKED (not executed)
 *     while any verification command has failed this session and not been
 *     re-run green. Mirrors the repo's mandatory Pre-Push Test Gate.
 *   - STAGING WARNING: a non-blocking warning when a broad `git add -A` /
 *     `git add .` / `git commit -a` is run while sensitive paths (`.env`,
 *     `.muonroi-cli/`, private keys, credentials) exist in the repo root.
 *
 * The push gate is deterministic for the sequential case (a failed check then
 * a later push). The concurrent case (push batched in the same parallel tool
 * call as the check) is covered by the system-prompt git-safety clause.
 *
 * Override the push gate with `MUONROI_ALLOW_PUSH_ON_RED=1`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isVerificationCommand } from "../orchestrator/tool-args-hash.js";

interface GitSafetyEntry {
  /** canonical verification command -> epoch ms it last failed. */
  failedVerifies: Map<string, number>;
}

declare global {
  // eslint-disable-next-line no-var
  var __muonroiGitSafetyState: Map<string, GitSafetyEntry> | undefined;
}

function getState(): Map<string, GitSafetyEntry> {
  if (!globalThis.__muonroiGitSafetyState) {
    globalThis.__muonroiGitSafetyState = new Map<string, GitSafetyEntry>();
  }
  return globalThis.__muonroiGitSafetyState;
}

/** Test helper — clear all session git-safety state. */
export function __resetGitSafetyState(): void {
  globalThis.__muonroiGitSafetyState = new Map<string, GitSafetyEntry>();
}

/**
 * Blank out single/double-quoted substrings so a commit MESSAGE that merely
 * mentions "git push" or "-a" never trips the classifiers. Cheap and good
 * enough — we only need to avoid matching inside obvious quoted args.
 */
function stripQuoted(command: string): string {
  return command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

// Each classifier scopes to ONE shell clause: `[^|&;\n]*` stops at pipes,
// `&`/`;`, AND newlines (all bash clause separators), so a separate command on
// another line (`git status\necho push`) cannot bleed into a false match. The
// `[ \t]` before the subcommand (not `\s`) keeps the match on one line and
// avoids `--grep=push` / `=push`. Quote-stripping upstream avoids commit-message
// hits. Allowing `[^|&;\n]*` between `git` and the subcommand covers global
// options like `git -c key=val push`.
const PUSH_RE = /\bgit\b[^|&;\n]*[ \t]push\b/;
const BROAD_ADD_RE = /\bgit\b[^|&;\n]*[ \t]add[ \t]+(?:-A\b|--all\b|\.(?=[ \t]|$))/;
// `-a` / `-am` / `-ma` etc. — a short-flag cluster CONTAINING `a`, terminated by
// whitespace or end (so `-a--otherflag` and `--amend` do NOT match).
const COMMIT_ALL_RE = /\bgit\b[^|&;\n]*[ \t]commit\b[^|&;\n]*[ \t]-[a-z]*a[a-z]*(?=[ \t]|$)/;
// Any `git commit` (with or without `-a`). `commit` must end at whitespace or
// the clause boundary so plumbing like `commit-tree` / `commit-graph` and
// option values like `--grep=commit` do NOT match. Drives the bash-tool LSP
// commit gate so a raw `git commit` cannot bypass the `git_commit` tool's gate.
const COMMIT_RE = /\bgit\b[^|&;\n]*[ \t]commit(?=[ \t]|$)/;

export interface GitCommandShape {
  isPush: boolean;
  /** `git add -A` / `git add .` / `git add --all` / `git commit -a[m]`. */
  isBroadStage: boolean;
  /** Any `git commit` (with or without `-a`). Gated by the LSP commit gate. */
  isCommit: boolean;
  /** `git add -A` / `git add .` / `git add --all` (stages the whole working tree). */
  isBroadAdd: boolean;
  /** `git commit -a[m]` (auto-stages tracked modifications at commit time). */
  isCommitAll: boolean;
}

export function analyzeGitCommand(command: string): GitCommandShape {
  const c = stripQuoted(command);
  const isBroadAdd = BROAD_ADD_RE.test(c);
  const isCommitAll = COMMIT_ALL_RE.test(c);
  return {
    isPush: PUSH_RE.test(c),
    isBroadStage: isBroadAdd || isCommitAll,
    isCommit: COMMIT_RE.test(c),
    isBroadAdd,
    isCommitAll,
  };
}

/**
 * Record the outcome of a bash command for the push gate. Only verification
 * commands (test/build/lint/typecheck) are tracked. A pass clears that exact
 * command's failed flag; a failure sets it. Non-verification commands are
 * ignored.
 */
export function recordCommandOutcome(sessionKey: string, canonical: string, success: boolean): void {
  if (!canonical || !isVerificationCommand(canonical)) return;
  const state = getState();
  let entry = state.get(sessionKey);
  if (!entry) {
    entry = { failedVerifies: new Map() };
    state.set(sessionKey, entry);
  }
  if (success) {
    entry.failedVerifies.delete(canonical);
  } else {
    entry.failedVerifies.set(canonical, Date.now());
  }
}

export interface PushGateResult {
  blocked: boolean;
  /** Canonical commands that failed and gate the push. */
  failed: string[];
}

export function checkPushGate(sessionKey: string): PushGateResult {
  if (process.env.MUONROI_ALLOW_PUSH_ON_RED === "1") return { blocked: false, failed: [] };
  const entry = getState().get(sessionKey);
  if (!entry || entry.failedVerifies.size === 0) return { blocked: false, failed: [] };
  return { blocked: true, failed: [...entry.failedVerifies.keys()] };
}

/** Message returned in place of running a blocked `git push`. */
export function pushBlockedMessage(failed: string[]): string {
  const list = failed.map((c) => `  • ${c}`).join("\n");
  return (
    "BLOCKED: refusing to run `git push` — a verification command failed earlier this session and has not passed since:\n" +
    `${list}\n\n` +
    "Re-run the failing check until it passes (0 failures), then push. This mirrors the mandatory Pre-Push Test Gate " +
    "(never push on red). If you must override for a genuine reason, set MUONROI_ALLOW_PUSH_ON_RED=1."
  );
}

/**
 * Message returned in place of running a blocked bash `git commit`. Mirrors the
 * G1 `git_commit` tool gate: the agent must FIX the reported errors, not bypass
 * the gate — so (per the G1 convention) the user-only `MUONROI_COMMIT_GATE=0`
 * escape hatch is intentionally NOT advertised here.
 */
export function commitBlockedMessage(summary?: string): string {
  return (
    "BLOCKED: refusing to run `git commit` — staged file(s) have errors that must be fixed first:\n" +
    `${summary ?? "(no diagnostic detail available)"}\n\n` +
    "Fix the reported errors, re-stage the file(s), then commit again. This mirrors the `git_commit` " +
    "tool's quality gate so a bash `git commit` cannot bypass it."
  );
}

// Repo-root paths that should essentially never be committed. Presence-based
// (fs.existsSync) so the check is O(1) and never spawns git.
const SENSITIVE_NAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".muonroi-cli",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  ".npmrc",
];

/** Sensitive paths present in `cwd` that a broad `git add` would likely sweep in. */
export function detectSensitiveStaging(cwd: string): string[] {
  const found: string[] = [];
  for (const name of SENSITIVE_NAMES) {
    try {
      if (fs.existsSync(path.join(cwd, name))) found.push(name);
    } catch {
      // ignore unreadable entries — best-effort detection only
    }
  }
  return found;
}

/** Non-blocking warning appended to a broad-stage command's output, or "". */
export function stagingWarning(cwd: string): string {
  const sensitive = detectSensitiveStaging(cwd);
  if (sensitive.length === 0) return "";
  return (
    "\n\n[WARNING: a broad `git add`/`git commit -a` was run while these sensitive paths exist in the repo root: " +
    `${sensitive.join(", ")}. Verify none were staged (git status), stage files EXPLICITLY (git add <path>), and ensure ` +
    "secrets are gitignored before committing/pushing.]"
  );
}
