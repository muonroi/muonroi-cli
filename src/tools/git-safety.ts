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

import { spawnSync } from "node:child_process";
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
//
// Patterns cover:
//   - All .env variants (.env, .env.*, *.env)
//   - SSH private keys (id_rsa, id_ed25519, id_ecdsa, id_dsa, *.pem, *.key)
//   - Cloud / service credentials
//   - muonroi-cli settings (may hold provider API keys)
const SENSITIVE_NAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".env.staging",
  ".muonroi-cli",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials.json",
  "service-account.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws",
  ".kube",
  ".docker",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
];

/** Sensitive file name suffixes checked via endsWith (catches *.pem, *.key, *.pfx). */
const SENSITIVE_SUFFIXES = [".pem", ".key", ".pfx", ".p12", ".env"];

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
  // Scan shallow directory entries for sensitive suffixes (*.pem, *.key, etc.)
  // Only the cwd root — not recursive — to keep this O(n) and fast.
  try {
    const entries = fs.readdirSync(cwd);
    for (const entry of entries) {
      if (found.includes(entry)) continue; // already captured
      const lower = entry.toLowerCase();
      if (SENSITIVE_SUFFIXES.some((s) => lower.endsWith(s))) {
        found.push(entry);
      }
    }
  } catch {
    // ignore — e.g. permission error on readdir
  }
  return found;
}

export interface StagingBlockResult {
  /** true means broad staging must be blocked (pre-execution). */
  blocked: boolean;
  /** Sensitive paths found in the working directory root. */
  sensitive: string[];
  /** Human-readable block message to return from the bash tool. */
  message: string;
}

/**
 * Hard-block check for broad `git add`/`git commit -a` when sensitive files are
 * present in the working directory.
 *
 * Replaces the non-blocking `stagingWarning()`. Returns blocked=true when
 * sensitive paths are detected. The caller (registry.ts bash tool) must
 * return `result.message` WITHOUT executing the command.
 *
 * The user can override this gate by:
 *   1. Explicitly staging only the files they want (`git add <path>` instead of `-A`).
 *   2. Setting MUONROI_ALLOW_BROAD_STAGE=1 (escape hatch, logged to decision-log).
 */
export function checkSensitiveStaging(cwd: string): StagingBlockResult {
  if (process.env.MUONROI_ALLOW_BROAD_STAGE === "1") {
    return { blocked: false, sensitive: [], message: "" };
  }
  const sensitive = detectSensitiveStaging(cwd);
  if (sensitive.length === 0) return { blocked: false, sensitive: [], message: "" };
  const list = sensitive.map((n) => `  • ${n}`).join("\n");
  const message =
    "BLOCKED: refusing broad `git add`/`git commit -a` — the following sensitive " +
    "paths exist in the repo root and would be swept into the staging area:\n" +
    `${list}\n\n` +
    "Stage files EXPLICITLY with `git add <path>` to avoid accidentally committing " +
    "secrets or credentials. Ensure these paths are listed in .gitignore. " +
    "To bypass this gate (not recommended), set MUONROI_ALLOW_BROAD_STAGE=1.";
  return { blocked: true, sensitive, message };
}

// ── Destructive-op guard (2026-07-12) ──────────────────────────────────────
//
// Motivation: an autonomous /ideal plan-adherence fix sub-agent ran
// `git checkout -- <files>` + committed the result, silently discarding the
// user's UNCOMMITTED, unrelated working-tree changes (a whole set of harness
// fixes). No existing guard caught it. This guard classifies commands that
// irreversibly discard uncommitted work and blocks them PRE-EXECUTION when
// there is actually work at risk. Routed as the `destructive-revert` safety
// kind: interactive → askcard (allow-once/block, never auto-allow even in
// yolo); headless/autonomous → hard-block. Escape hatch:
// MUONROI_ALLOW_DESTRUCTIVE_REVERT=1 (user-set, logged like the other gates).

// `git checkout … -- ` (discard paths) OR `git checkout .` (discard all).
const CHECKOUT_DISCARD_RE = /\bgit\b[^|&;\n]*[ \t]checkout\b(?:[^|&;\n]*[ \t]--(?:[ \t]|$)|[ \t]+\.(?=[ \t]|$))/;
// `git restore …` discards the working tree by default. `git restore --staged`
// WITHOUT `--worktree`/`-W` only unstages (non-destructive) — exempt that.
const RESTORE_RE = /\bgit\b[^|&;\n]*[ \t]restore\b/;
const RESTORE_STAGED_RE = /[ \t]--staged\b/;
const RESTORE_WORKTREE_RE = /[ \t](?:--worktree\b|-[a-z]*W)/;
// `git reset --hard` throws away all uncommitted changes.
const RESET_HARD_RE = /\bgit\b[^|&;\n]*[ \t]reset\b[^|&;\n]*[ \t]--hard\b/;
// `git clean -f[d][x]` deletes untracked files.
const CLEAN_FORCE_RE = /\bgit\b[^|&;\n]*[ \t]clean\b[^|&;\n]*[ \t]-[a-eg-wyz]*f/;
// `git stash drop` / `git stash clear` destroy stashed work.
const STASH_DROP_RE = /\bgit\b[^|&;\n]*[ \t]stash[ \t]+(?:drop|clear)\b/;
// `rm` (not rmdir) — targets checked against git tracking below.
const RM_RE = /(?:^|[|&;\n]|\s)rm\b(?!dir)/;

export type DestructiveKind = "checkout-discard" | "restore" | "reset-hard" | "clean" | "stash-drop" | "rm-tracked";

export interface DestructiveShape {
  kind: DestructiveKind | null;
  /** true when the risk is untracked files (clean) rather than tracked mods. */
  untrackedRisk: boolean;
}

export function analyzeDestructiveGit(command: string): DestructiveShape {
  const c = stripQuoted(command);
  if (RESET_HARD_RE.test(c)) return { kind: "reset-hard", untrackedRisk: false };
  if (CHECKOUT_DISCARD_RE.test(c)) return { kind: "checkout-discard", untrackedRisk: false };
  if (RESTORE_RE.test(c)) {
    const stagedOnly = RESTORE_STAGED_RE.test(c) && !RESTORE_WORKTREE_RE.test(c);
    if (!stagedOnly) return { kind: "restore", untrackedRisk: false };
  }
  if (CLEAN_FORCE_RE.test(c)) return { kind: "clean", untrackedRisk: true };
  if (STASH_DROP_RE.test(c)) return { kind: "stash-drop", untrackedRisk: false };
  return { kind: null, untrackedRisk: false };
}

function git(cwd: string, args: string[]): string {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

// ─── History/ref-writing subcommand detector (autoCommit-disabled gate) ────
//
// `analyzeGitCommand`'s isCommit/isPush are loose "does the word appear
// somewhere in this clause" regexes over the QUOTE-STRIPPED command — good
// enough for the push-gate/staging-warning features they drive, but
// bypassable two ways a refuter found (round 2):
//   1. `stripQuoted` blanks ANY quoted substring, so `sh -c "git commit -am x"`
//      becomes `sh -c ""` before the regex ever runs — the whole invocation
//      vanishes.
//   2. They only recognize `commit`/`push`; `git merge`, `cherry-pick`,
//      `rebase --continue`, `am`, `revert`, `commit-tree`, `update-ref`,
//      `tag`, `pull`, and a user's own alias (`git ci` -> commit) all write
//      history or refs just as much and were never classified at all.
//
// Round 3: string parsing of an arbitrary shell command line is an arms race
// (a refuter kept finding new ways to say "git" without the literal token
// `git`) — this detector is now a defense-in-depth EARLY warning, not the
// sole guarantee; `git-effect-guard.ts` is the real backstop (it snapshots
// refs and undoes any it did not expect, regardless of how the command spelled
// "git"). This detector still matters for `push` specifically — a push
// cannot be undone once the remote has it, so it must still be caught
// BEFORE execution. Round-3 additions:
//   3. `\git` (a literal backslash before the word, the standard way to
//      bypass a shell alias/function of the same name) didn't match the bare
//      token `git`.
//   4. `git${IFS}commit` / `git$IFS commit` — `$IFS` is the shell's field
//      separator variable; gluing it into a word with no literal whitespace
//      still splits into two words at RUN time, but a naive whitespace split
//      never saw two tokens.
//   5. `-c alias.<x>=<v>` DEFINED on the same command line was never looked
//      up — only a persisted `git config --get alias.<word>` was checked, so
//      an inline, never-persisted alias definition sailed through.
//   6. `echo commit | xargs git` — the actual subcommand comes from stdin at
//      run time, invisible to any static scan; must be blocked
//      conservatively UNLESS the command line itself already shows a
//      concrete (and safe) subcommand right after `git` in that xargs
//      invocation (`xargs git log` — "log" is fixed text, only the per-line
//      argument comes from stdin).
//   7. FALSE POSITIVE fix: `git tag` with no arguments, or only `-l`/
//      `--list`/`-n`/`-v`, lists/inspects tags — it does not create one.
//
// This detector is deliberately separate from `analyzeGitCommand` (used only
// by the autoCommit-disabled bash-tool gate, registry.ts) rather than a
// patch to it, because it makes an opposite, INTENTIONALLY more paranoid
// tradeoff: it scans the RAW command — quotes included — so a `git` token
// hidden inside a `sh -c`/`bash -c`/`eval "..."` string argument is still
// found (the same reason it can also flag an `echo "... git commit ..."` that
// never actually invokes git; accepted, since this only fires when a project
// has explicitly disabled auto-commit and a false block is recoverable — the
// user can just ask again — while a silent bypass is not).
//
// Unlike the loose "word appears somewhere" regexes, the subcommand is found
// by tokenizing and taking the FIRST non-flag token after `git` (skipping
// global flags, including the two-token forms `-c <k>=<v>` / `-C <dir>`) —
// this is what fixes the `git log --grep push` false positive structurally:
// "push" two tokens later than the subcommand slot is never inspected.
const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Native subcommands common enough to skip an `alias.<word>` lookup for. */
const KNOWN_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "grep",
  "rev-parse",
  "for-each-ref",
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "tag",
  "branch",
  "checkout",
  "restore",
  "reset",
  "stash",
  "clone",
  "init",
  "config",
  "remote",
  "worktree",
  "notes",
  "am",
  "commit-tree",
  "update-ref",
  "diff-tree",
  "ls-files",
  "cat-file",
  "hash-object",
  "symbolic-ref",
  "describe",
  "shortlog",
  "reflog",
  "gc",
  "fsck",
  "prune",
  "submodule",
  "apply",
  "format-patch",
  "send-email",
  "request-pull",
  "bisect",
  "rerere",
  "replace",
  "filter-branch",
  "mergetool",
  "difftool",
  "instaweb",
  "archive",
  "bundle",
  "credential",
  "help",
  "version",
]);

/**
 * History-writing (creates/rewrites a commit) or ref-writing (moves a branch/
 * tag/notes ref) subcommands — blocked when a project disables auto-commit.
 * `stash` is a deliberate judgement call: only its ref-writing forms
 * (`push`/`store`, which write `refs/stash`) are blocked — `apply`/`pop`/
 * `list`/`show`/`drop` never create a commit reachable from a branch, so they
 * stay allowed. `notes` similarly only blocks its writing subcommands.
 */
const BLOCKED_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "cherry-pick",
  "rebase",
  "am",
  "revert",
  "commit-tree",
  "update-ref",
  "tag",
  "push",
  "pull",
]);
const STASH_WRITE_SUBWORDS = new Set(["push", "store"]);
const NOTES_WRITE_SUBWORDS = new Set(["add", "append", "edit", "remove", "merge", "prune", "copy"]);
/** `git tag` with ONLY these (or no args at all) lists/inspects — read-only. */
const TAG_READ_ONLY_ARG_RE = /^(-l|--list|-n\d*|-v)$/;
const CLAUSE_BOUNDARY = new Set([";", "&", "|", "(", ")"]);

function stripSurroundingQuotes(token: string): string {
  return token.replace(/^["']+/, "").replace(/["']+$/, "");
}

/** A leading `\` (the standard way to invoke a name bypassing a shell alias/function of the same spelling). */
function stripLeadingBackslash(token: string): string {
  return token.replace(/^\\+/, "");
}

/** `${IFS}` / `$IFS` glued onto a word still splits it into two words at run time. */
function normalizeIFS(command: string): string {
  return command.replace(/\$\{IFS\}|\$IFS\b/g, " ");
}

/**
 * Split `command` into shell-metacharacter-aware tokens for the SOLE purpose
 * of finding `git` occurrences and the token that follows — not a full shell
 * parser. `;`, `&`, `|`, `(`, `)` are forced apart from adjacent words first
 * (so `git commit;git push` tokenizes as two clauses) before a plain
 * whitespace split.
 */
function tokenizeForGitScan(command: string): string[] {
  return normalizeIFS(command)
    .replace(/([;&|()])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stripSurroundingQuotes)
    .map(stripLeadingBackslash)
    .filter(Boolean);
}

/**
 * Inline `-c alias.<name>=<value>` definitions on THIS command line — a
 * one-shot alias that never touches persisted config, so `git config --get
 * alias.<name>` (looked up against the repo) would never see it.
 */
function extractInlineAliases(command: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /-c\s+alias\.([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null = re.exec(command);
  while (m) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (value) map.set(name, value);
    m = re.exec(command);
  }
  return map;
}

/** [start, end) token-index range of the clause containing `idx` (bounded by `;`/`&`/`|`/`(`/`)`). */
function clauseRange(tokens: string[], idx: number): [number, number] {
  let start = idx;
  while (start > 0 && !CLAUSE_BOUNDARY.has(tokens[start - 1])) start--;
  let end = idx;
  while (end < tokens.length && !CLAUSE_BOUNDARY.has(tokens[end])) end++;
  return [start, end];
}

export interface BlockedGitSubcommandResult {
  blocked: boolean;
  /** The subcommand that triggered the block (post-alias-resolution). */
  subcommand?: string;
  /** Set when `subcommand` was reached by resolving a user git alias. */
  viaAlias?: string;
}

/**
 * True when `command` contains (anywhere, including inside quoted
 * `sh -c`/`bash -c`/`eval` strings) a `git` invocation whose subcommand
 * writes history or a ref — directly, or through a user-defined alias
 * (an inline `-c alias.<word>=...` on this line, or a persisted
 * `git config --get alias.<word>`, resolved one level deep). See the module
 * comment above `GIT_GLOBAL_FLAGS_WITH_ARG` for the full rationale.
 */
export function detectBlockedGitSubcommand(command: string, cwd: string): BlockedGitSubcommandResult {
  const tokens = tokenizeForGitScan(command);
  const inlineAliases = extractInlineAliases(command);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git") continue;
    const [clauseStart, clauseEnd] = clauseRange(tokens, i);

    let j = i + 1;
    while (j < clauseEnd && (GIT_GLOBAL_FLAGS_WITH_ARG.has(tokens[j]) || tokens[j].startsWith("-"))) {
      j += GIT_GLOBAL_FLAGS_WITH_ARG.has(tokens[j]) ? 2 : 1;
    }

    if (j >= clauseEnd) {
      // No subcommand token visible on the line for THIS `git` occurrence.
      // If it is being fed by `xargs` in the same clause, the real
      // subcommand comes from stdin at run time and cannot be inspected
      // statically — block conservatively.
      if (tokens.slice(clauseStart, i).includes("xargs")) {
        return { blocked: true, subcommand: "xargs-piped(unknown subcommand from stdin)" };
      }
      continue;
    }

    const rawSub = tokens[j];
    const [word] = rawSub.split(/(?=[^a-z0-9-])/i); // split off a trailing punctuation blob, if any
    const candidate = (word ?? rawSub).toLowerCase();

    if (candidate === "stash") {
      const next = tokens[j + 1]?.toLowerCase();
      if (next && STASH_WRITE_SUBWORDS.has(next)) return { blocked: true, subcommand: `stash ${next}` };
      continue;
    }
    if (candidate === "notes") {
      const next = tokens[j + 1]?.toLowerCase();
      if (next && NOTES_WRITE_SUBWORDS.has(next)) return { blocked: true, subcommand: `notes ${next}` };
      continue;
    }
    if (candidate === "tag") {
      const tagArgs = tokens.slice(j + 1, clauseEnd);
      // Read-only: no args at all, OR every arg is one of -l/--list/-n[num]/-v,
      // OR is the operand immediately following -l/--list/-v (a list pattern
      // or the tag being verified — neither creates/moves a ref).
      const isReadOnly =
        tagArgs.length === 0 ||
        tagArgs.every(
          (a, idx) => TAG_READ_ONLY_ARG_RE.test(a) || (idx > 0 && /^(-l|--list|-v)$/.test(tagArgs[idx - 1] ?? "")),
        );
      if (isReadOnly) continue;
      return { blocked: true, subcommand: "tag" };
    }

    if (BLOCKED_SUBCOMMANDS.has(candidate)) return { blocked: true, subcommand: candidate };

    if (!KNOWN_GIT_SUBCOMMANDS.has(candidate) && /^[a-z][a-z0-9-]*$/.test(candidate)) {
      const aliasValue = inlineAliases.get(candidate) ?? git(cwd, ["config", "--get", `alias.${candidate}`]);
      if (aliasValue) {
        const aliasTarget = tokenizeForGitScan(aliasValue)[0]?.toLowerCase();
        if (aliasTarget && BLOCKED_SUBCOMMANDS.has(aliasTarget)) {
          return { blocked: true, subcommand: aliasTarget, viaAlias: candidate };
        }
      }
    }
  }
  return { blocked: false };
}

/** Working-tree paths that a destructive command would discard (best-effort). */
function atRiskPaths(cwd: string, untrackedRisk: boolean): string[] {
  // NOTE: read raw stdout — do NOT trim the whole output. Porcelain v1 lines
  // are "XY<space>PATH" where XY is 2 chars; a global trim would eat the leading
  // space of a " M file" line and shift the path parse by one character.
  let raw: string;
  try {
    const r = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    raw = r.stdout ?? "";
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    const isUntracked = xy === "??";
    if (untrackedRisk ? isUntracked : !isUntracked && xy !== "!!") out.push(file);
  }
  return out;
}

/** Extract rm target tokens (non-flag args) from a single-clause rm command. */
function rmTargets(command: string): string[] {
  const c = stripQuoted(command);
  const m = c.match(/(?:^|[|&;\n]|\s)rm\b(?!dir)([^|&;\n]*)/);
  if (!m) return [];
  return m[1]
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith("-") && t !== '""' && t !== "''");
}

/** rm targets that are git-tracked (file directly, or a dir containing tracked files). */
function rmTrackedTargets(cwd: string, command: string): string[] {
  const targets = rmTargets(command);
  const tracked: string[] = [];
  for (const t of targets) {
    // Tracked file?
    const asFile = spawnSync("git", ["ls-files", "--error-unmatch", t], {
      cwd,
      encoding: "utf8",
      timeout: 6000,
    });
    if (asFile.status === 0) {
      tracked.push(t);
      continue;
    }
    // Directory containing tracked files?
    const underDir = git(cwd, ["ls-files", "--", t]);
    if (underDir) tracked.push(t);
  }
  return tracked;
}

export interface DestructiveBlockResult {
  blocked: boolean;
  kind: DestructiveKind | null;
  message: string;
}

/**
 * Pre-execution guard: block a working-tree-destroying command when it would
 * actually discard uncommitted work. Returns blocked=false (no message) when
 * the command is non-destructive, when nothing is at risk, or when the user set
 * the escape hatch. Deterministic + cheap (a couple of git plumbing calls).
 */
export function checkDestructiveOp(command: string, cwd: string): DestructiveBlockResult {
  if (process.env.MUONROI_ALLOW_DESTRUCTIVE_REVERT === "1") {
    return { blocked: false, kind: null, message: "" };
  }

  const shape = analyzeDestructiveGit(command);
  if (shape.kind) {
    let atRisk: string[];
    if (shape.kind === "stash-drop") {
      atRisk = git(cwd, ["stash", "list"]).split("\n").filter(Boolean);
    } else {
      atRisk = atRiskPaths(cwd, shape.untrackedRisk);
    }
    if (atRisk.length === 0) return { blocked: false, kind: shape.kind, message: "" };
    return { blocked: true, kind: shape.kind, message: destructiveMessage(shape.kind, atRisk) };
  }

  if (RM_RE.test(stripQuoted(command))) {
    const tracked = rmTrackedTargets(cwd, command);
    if (tracked.length > 0) {
      return { blocked: true, kind: "rm-tracked", message: destructiveMessage("rm-tracked", tracked) };
    }
  }

  return { blocked: false, kind: null, message: "" };
}

function destructiveMessage(kind: DestructiveKind, items: string[]): string {
  const list = items
    .slice(0, 30)
    .map((n) => `  • ${n}`)
    .join("\n");
  const more = items.length > 30 ? `\n  … and ${items.length - 30} more` : "";
  const verb: Record<DestructiveKind, string> = {
    "checkout-discard": "`git checkout` discarding working-tree changes",
    restore: "`git restore` discarding working-tree changes",
    "reset-hard": "`git reset --hard` discarding ALL uncommitted changes",
    clean: "`git clean` deleting untracked files",
    "stash-drop": "`git stash drop/clear` destroying stashed work",
    "rm-tracked": "`rm` deleting git-tracked file(s)",
  };
  return (
    `BLOCKED: refusing ${verb[kind]} — this irreversibly discards uncommitted work:\n` +
    `${list}${more}\n\n` +
    "These changes are NOT committed and cannot be recovered once discarded. If you did " +
    "not intend to destroy them, leave them alone (they may be the user's unrelated work). " +
    "To keep them, `git add` + `git commit` (or `git stash`) FIRST, then retry. To bypass " +
    "this guard for a genuine, intentional discard, set MUONROI_ALLOW_DESTRUCTIVE_REVERT=1."
  );
}

/**
 * @deprecated Use checkSensitiveStaging() for hard-blocking.
 * Kept for call sites that emit a trailing warning (non-broad-stage contexts).
 */
export function stagingWarning(cwd: string): string {
  const sensitive = detectSensitiveStaging(cwd);
  if (sensitive.length === 0) return "";
  return (
    "\n\n[WARNING: sensitive paths exist in the repo root: " +
    `${sensitive.join(", ")}. Verify none were staged (git status) and ensure ` +
    "secrets are gitignored before committing/pushing.]"
  );
}
