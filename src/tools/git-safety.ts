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
 * Guards (host-enforced — the prompt only carries a one-line pointer):
 *   - PUSH GATE: `git push` is BLOCKED (not executed) unless the session has
 *     a PASSING run of every required test gate of the project's verify recipe
 *     (`resolveGateCatalog`, the same source as run_gate / prepareVerifyRun),
 *     STARTED after the session's last native file write; and while any
 *     verification command failed and was not re-run green. Runs are recorded
 *     from bash, `run_gate` and `verification_run` (failures only — a subset of
 *     test files is not the gate). A run whose exit status a pipe/`;`/`||`
 *     masks never counts as a pass. No detectable test gate → allowed with a
 *     recorded warning (nothing to name; blocking would be a dead end).
 *   - HOOK BYPASS: `--no-verify` / `commit -n` / `-c core.hooksPath=` /
 *     `HUSKY=0` / `git config core.hooksPath` writes are refused.
 *   - BROAD STAGING: `git add -A|.|-u` / `commit -a` is refused while dirty
 *     paths exist that this session did not write (lists them), and while
 *     sensitive paths (`.env`, `.muonroi-cli/`, keys) exist in the repo root.
 *
 * Every refusal is a `BLOCKED (git-safety)` result, so the existing safety
 * override applies: interactive → safety askcard (allow once / session), yolo
 * → auto-allow, headless → hard block. User env escape hatches:
 * `MUONROI_ALLOW_PUSH_ON_RED=1` (push gate), `MUONROI_ALLOW_BROAD_STAGE=1`
 * (staging), `MUONROI_ALLOW_HOOK_BYPASS=1` (hook bypass).
 *
 * Known limits: file writes made through bash (`sed -i`, generators) or MCP
 * tools are not seen as "writes" by the push gate; a concurrent test run and
 * push in one parallel batch is blocked (the run has not passed yet).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isVerificationCommand } from "../orchestrator/tool-args-hash.js";
import { logger } from "../utils/logger.js";
import { normalizeMsysDrivePath } from "./write-scope.js";

/** One bash/run_gate command observed in a directory. Seqs are run START seqs. */
interface RunRecord {
  dir: string;
  command: string;
  passSeq: number;
  failSeq: number;
  /** A success whose exit status was masked (pipe / `;` / `||`) — never a pass. */
  maskedPassSeq: number;
}

interface GitSafetyEntry {
  /** canonical verification command -> epoch ms it last failed. */
  failedVerifies: Map<string, number>;
  /** Seq of the last successful native file write (0 = none this session). */
  lastWriteSeq: number;
  /** Normalized absolute paths written by native file tools this session. */
  writtenPaths: Set<string>;
  /** `${dir}\0${command}` -> outcome record (insertion-ordered, bounded). */
  runs: Map<string, RunRecord>;
}

const MAX_RUN_RECORDS = 300;

declare global {
  // eslint-disable-next-line no-var
  var __muonroiGitSafetyState: Map<string, GitSafetyEntry> | undefined;
  // eslint-disable-next-line no-var
  var __muonroiGitSafetySeq: number | undefined;
}

function getState(): Map<string, GitSafetyEntry> {
  if (!globalThis.__muonroiGitSafetyState) {
    globalThis.__muonroiGitSafetyState = new Map<string, GitSafetyEntry>();
  }
  return globalThis.__muonroiGitSafetyState;
}

function getEntry(sessionKey: string): GitSafetyEntry {
  const state = getState();
  let entry = state.get(sessionKey);
  if (!entry) {
    entry = { failedVerifies: new Map(), lastWriteSeq: 0, writtenPaths: new Set(), runs: new Map() };
    state.set(sessionKey, entry);
  }
  return entry;
}

/** Test helper — clear all session git-safety state. */
export function __resetGitSafetyState(): void {
  globalThis.__muonroiGitSafetyState = new Map<string, GitSafetyEntry>();
}

/**
 * Monotonic ordering stamp shared by writes and command starts. A counter, not
 * a clock: a write and a test start in the same millisecond must still order.
 */
export function nextGitSafetySeq(): number {
  globalThis.__muonroiGitSafetySeq = (globalThis.__muonroiGitSafetySeq ?? 0) + 1;
  return globalThis.__muonroiGitSafetySeq;
}

/** Normalized absolute path/dir key (MSYS drive spelling, case-folded on win32). */
export function normalizeSafetyPath(p: string, base?: string): string {
  const spelled = normalizeMsysDrivePath(p);
  const abs = base ? path.resolve(normalizeMsysDrivePath(base), spelled) : path.resolve(spelled);
  const trimmed = abs.length > 1 ? abs.replace(/[\\/]+$/, "") : abs;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * normalizeSafetyPath on the path's REAL spelling. Paths reach the broad-staging
 * guard in two spellings of one directory: written paths come from the tool's
 * cwd (a symlinked macOS tmp under /var, or a Windows 8.3 TEMP like
 * C:\Users\RUNNER~1), while dirty paths are joined onto `git rev-parse
 * --show-toplevel`, which git prints canonical (/private/var, the long name).
 * Compared lexically, every own file looked foreign (ci-matrix on d7363a46,
 * mac + win; reproduced locally with TEMP at a junction and at an 8.3 alias).
 * A path that no longer exists (deleted file) resolves through its parent.
 */
export function canonicalSafetyPath(p: string, base?: string): string {
  const abs = normalizeSafetyPath(p, base);
  try {
    return normalizeSafetyPath(fs.realpathSync.native(abs));
  } catch (err) {
    try {
      return normalizeSafetyPath(path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)));
    } catch (parentErr) {
      // Expected for a path whose parent is gone too: fall back to the lexical key.
      logger.file("debug", "orchestrator", "[git-safety] canonical path unresolved; using lexical key", {
        operation: "canonicalSafetyPath",
        path: abs,
        error: err instanceof Error ? err.message : String(err),
        parentError: parentErr instanceof Error ? parentErr.message : String(parentErr),
      });
      return abs;
    }
  }
}

/**
 * Record successful native file writes (write_file / edit_file). Invalidates
 * every earlier test pass for the push gate and feeds the broad-staging guard.
 */
export function noteFileWrites(sessionKey: string, absolutePaths: readonly string[]): void {
  if (absolutePaths.length === 0) return;
  const entry = getEntry(sessionKey);
  entry.lastWriteSeq = nextGitSafetySeq();
  for (const p of absolutePaths) entry.writtenPaths.add(normalizeSafetyPath(p));
}

/** Normalized absolute paths written by native file tools this session. */
export function sessionWrittenPaths(sessionKey: string): string[] {
  return [...(getState().get(sessionKey)?.writtenPaths ?? [])];
}

const normalizeCommandText = (command: string): string => command.trim().replace(/\s+/g, " ");

// Redirections never change an exit status; strip them before comparing a run
// to a gate command (`bun run test 2>&1 > out.log` IS `bun run test`).
function stripRedirections(command: string): string {
  // Park quoted spans so a `=>` / `>` inside a string argument is never read
  // as a redirection, then restore them.
  // Private-use code point as the placeholder fence: never valid shell text.
  const fence = "";
  const quoted: string[] = [];
  const parked = command.replace(/"[^"]*"|'[^']*'/g, (m) => `${fence}${quoted.push(m) - 1}${fence}`);
  const stripped = parked
    .replace(/[ \t]*\d*>>?[ \t]*&[ \t]*\d+/g, "")
    .replace(/[ \t]*&>>?[ \t]*\S+/g, "")
    .replace(/[ \t]*\d*>>?[ \t]*[^\s&|;]+/g, "");
  return stripped.replace(new RegExp(`${fence}(\\d+)${fence}`, "g"), (_m, i: string) => quoted[Number(i)] ?? "");
}

interface ParsedRun {
  clauses: Array<{ dir: string; command: string }>;
  /** True when the overall exit status does not prove every clause succeeded. */
  masked: boolean;
}

/**
 * Split a bash command at top-level `&&` (quote-aware), following `cd <dir>`
 * clauses so each remaining clause is keyed by the directory it ran in. Any
 * other top-level control operator (`|`, `||`, `;`, newline, background `&`)
 * makes the exit status unreliable for the clauses → `masked`.
 */
export function parseRunClauses(command: string, cwd: string): ParsedRun {
  const text = stripRedirections(command);
  const parts: string[] = [];
  let masked = false;
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && text[i + 1] === "&") {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      masked = true;
      if (ch === "|" && text[i + 1] === "|") i++;
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  // `set -o pipefail; cmd | tail` still counts as masked: honoring pipefail
  // would mean modelling `;` too, and the refusal already says "run unpiped".
  let dir = cwd;
  const clauses: Array<{ dir: string; command: string }> = [];
  for (const raw of parts) {
    const clause = normalizeCommandText(raw);
    if (!clause) continue;
    const cd = clause.match(/^cd[ \t]+(?:"([^"]+)"|'([^']+)'|(\S+))$/);
    if (cd) {
      dir = path.resolve(normalizeMsysDrivePath(dir), normalizeMsysDrivePath(cd[1] ?? cd[2] ?? cd[3]!));
      continue;
    }
    clauses.push({ dir, command: clause });
  }
  return { clauses, masked };
}

function upsertRun(entry: GitSafetyEntry, dir: string, command: string, update: (rec: RunRecord) => void): void {
  const key = `${normalizeSafetyPath(dir)}\0${command}`;
  const rec = entry.runs.get(key) ?? { dir, command, passSeq: 0, failSeq: 0, maskedPassSeq: 0 };
  update(rec);
  entry.runs.delete(key); // re-insert → most recently used last
  entry.runs.set(key, rec);
  while (entry.runs.size > MAX_RUN_RECORDS) {
    const oldest = entry.runs.keys().next().value;
    if (oldest === undefined) break;
    entry.runs.delete(oldest);
  }
}

/**
 * Record a finished bash command for the push gate's test-gate ledger. Every
 * command is recorded (the recipe's test command may be anything — `make
 * test`, `uv run pytest`); only gate-matching entries are ever read.
 * `startSeq` is taken BEFORE the command ran, so a write that lands while the
 * tests run makes that pass stale.
 */
export function recordBashRun(
  sessionKey: string,
  cwd: string,
  command: string,
  success: boolean,
  startSeq: number,
): void {
  const parsed = parseRunClauses(command, cwd);
  if (parsed.clauses.length === 0) return;
  const entry = getEntry(sessionKey);
  for (const clause of parsed.clauses) {
    upsertRun(entry, clause.dir, clause.command, (rec) => {
      if (!success) rec.failSeq = Math.max(rec.failSeq, startSeq);
      else if (parsed.masked) rec.maskedPassSeq = Math.max(rec.maskedPassSeq, startSeq);
      else rec.passSeq = Math.max(rec.passSeq, startSeq);
    });
  }
}

/** Record a host-executed `run_gate` outcome (the command is exactly the gate's). */
export function recordGateRun(
  sessionKey: string,
  cwd: string,
  command: string,
  success: boolean,
  startSeq: number,
): void {
  const entry = getEntry(sessionKey);
  upsertRun(entry, cwd, normalizeCommandText(command), (rec) => {
    if (success) rec.passSeq = Math.max(rec.passSeq, startSeq);
    else rec.failSeq = Math.max(rec.failSeq, startSeq);
  });
}

/**
 * Record a `verification_run` outcome. It runs an explicit subset of test
 * files, so a PASS never satisfies the test gate — but a FAIL is red evidence
 * that blocks a push until the same files pass again (legacy failed-verify map).
 */
export function recordVerificationRun(sessionKey: string, files: readonly string[], success: boolean): void {
  const key = `verification_run ${[...files].map(String).sort().join(" ")}`;
  const entry = getEntry(sessionKey);
  if (success) entry.failedVerifies.delete(key);
  else entry.failedVerifies.set(key, Date.now());
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
const BROAD_ADD_RE = /\bgit\b[^|&;\n]*[ \t]add[ \t]+(?:-A\b|--all\b|-u\b|--update\b|\.(?=[ \t]|$))/;
const ADD_ALL_RE = /\bgit\b[^|&;\n]*[ \t]add[ \t]+(?:-A\b|--all\b)/;
const ADD_UPDATE_RE = /\bgit\b[^|&;\n]*[ \t]add[ \t]+(?:-u\b|--update\b)/;
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
  /**
   * What a broad stage would sweep: `all` (tracked + untracked, repo-wide),
   * `cwd` (`git add .` — tracked + untracked under the cwd), `tracked`
   * (`add -u` / `commit -a` — tracked modifications only), or null.
   */
  broadStageScope: "all" | "cwd" | "tracked" | null;
  /** Description of a hook-bypass construct on a commit/push, or null. */
  hookBypass: string | null;
}

export function analyzeGitCommand(command: string): GitCommandShape {
  const c = stripQuoted(command);
  const isBroadAdd = BROAD_ADD_RE.test(c);
  const isCommitAll = COMMIT_ALL_RE.test(c);
  const isPush = PUSH_RE.test(c);
  const isCommit = COMMIT_RE.test(c);
  const broadStageScope: GitCommandShape["broadStageScope"] = ADD_ALL_RE.test(c)
    ? "all"
    : isBroadAdd && !ADD_UPDATE_RE.test(c)
      ? "cwd"
      : isBroadAdd || isCommitAll
        ? "tracked"
        : null;
  return {
    isPush,
    isBroadStage: isBroadAdd || isCommitAll,
    isCommit,
    isBroadAdd,
    isCommitAll,
    broadStageScope,
    hookBypass: detectHookBypass(c, isCommit || isPush),
  };
}

// ── Hook bypass (M2) ─────────────────────────────────────────────────────────
//
// The repo's pre-commit/pre-push hooks ARE the gate for every contributor; a
// model reaching for `--no-verify` turns the gate off for itself. Detected on
// the quote-stripped command, clause by clause, so a commit MESSAGE that
// mentions `--no-verify` never trips it.

/** `--no-verify` and its unique abbreviations (`--no-ver` is ambiguous with `--no-verbose`). */
const NO_VERIFY_LONG_RE = /^--no-veri(?:f(?:y)?)?$/;
/** git commit short options that take a value — letters after them are the value, not flags. */
const COMMIT_VALUE_FLAGS = new Set(["m", "F", "C", "c", "t"]);
/** Optional ATTACHED value (`-S<keyid>`, `-u<mode>`): the rest of the cluster is the value. */
const COMMIT_ATTACHED_VALUE_FLAGS = new Set(["S", "u"]);

function gitSubcommandTokens(clause: string): { sub: string; args: string[]; globals: string[] } | null {
  const tokens = clause
    .trim()
    .split(/[ \t]+/)
    .filter(Boolean);
  const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git") || t.toLowerCase() === "git.exe");
  if (gitIdx < 0) return null;
  const globals: string[] = [];
  let j = gitIdx + 1;
  while (j < tokens.length && tokens[j]!.startsWith("-")) {
    const flag = tokens[j]!;
    globals.push(flag);
    if (GIT_GLOBAL_FLAGS_WITH_ARG.has(flag) && j + 1 < tokens.length) globals.push(tokens[++j]!);
    j++;
  }
  if (j >= tokens.length) return null;
  return { sub: tokens[j]!.toLowerCase(), args: tokens.slice(j + 1), globals };
}

function commitShortClusterSkipsVerify(token: string): { noVerify: boolean; takesNext: boolean } {
  const letters = token.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const ch = letters[k]!;
    if (ch === "n") return { noVerify: true, takesNext: false };
    if (COMMIT_VALUE_FLAGS.has(ch)) return { noVerify: false, takesNext: k === letters.length - 1 };
    if (COMMIT_ATTACHED_VALUE_FLAGS.has(ch)) return { noVerify: false, takesNext: false };
  }
  return { noVerify: false, takesNext: false };
}

function detectHookBypass(quoteStripped: string, isCommitOrPush: boolean): string | null {
  for (const clause of quoteStripped.split(/[|&;\n]+/)) {
    const shape = gitSubcommandTokens(clause);
    if (!shape) continue;
    const hooksPathOverride = shape.globals.some((g, idx) => {
      const value = g === "-c" ? (shape.globals[idx + 1] ?? "") : "";
      return /^core\.hookspath=/i.test(value);
    });
    if (shape.sub === "config") {
      const writesHooksPath = shape.args.some((a, idx) => {
        if (!/^core\.hookspath$/i.test(a)) return false;
        const rest = shape.args.slice(idx + 1);
        const reads = shape.args.some((x) => /^--(?:get|get-all|get-regexp|list|show-origin)$/.test(x));
        const unsets = shape.args.some((x) => /^--unset(?:-all)?$/.test(x));
        return unsets || (!reads && rest.length > 0);
      });
      if (writesHooksPath) return "`git config core.hooksPath …` (re-points or removes the repo's hooks)";
      continue;
    }
    if (shape.sub !== "commit" && shape.sub !== "push") continue;
    if (hooksPathOverride) return `\`git -c core.hooksPath=… ${shape.sub}\` (skips the repo's hooks)`;
    if (/(?:^|[ \t])(?:export[ \t]+)?HUSKY(?:=0\b|_SKIP_HOOKS=(?:1|true)\b)/.test(clause))
      return `\`HUSKY=0 git ${shape.sub}\` (disables the husky hooks)`;
    let skipNext = false;
    for (const arg of shape.args) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (arg === "--") break;
      if (NO_VERIFY_LONG_RE.test(arg)) return `\`git ${shape.sub} --no-verify\``;
      // `-n` means --no-verify only for commit; for push it is --dry-run.
      if (shape.sub === "commit" && /^-[a-zA-Z]+$/.test(arg)) {
        const r = commitShortClusterSkipsVerify(arg);
        if (r.noVerify) return "`git commit -n` (short for --no-verify)";
        skipNext = r.takesNext;
      }
    }
  }
  // `export HUSKY=0` in an earlier clause still disables hooks for the commit.
  if (isCommitOrPush && /(?:^|[ \t;&|\n])export[ \t]+HUSKY=0\b/.test(quoteStripped))
    return "`export HUSKY=0` before a commit/push (disables the husky hooks)";
  return null;
}

export interface HookBypassBlockResult {
  blocked: boolean;
  message: string;
}

/** Refuse a hook-bypassing commit/push. User escape hatch: MUONROI_ALLOW_HOOK_BYPASS=1. */
export function checkHookBypass(shape: GitCommandShape): HookBypassBlockResult {
  if (!shape.hookBypass || process.env.MUONROI_ALLOW_HOOK_BYPASS === "1") return { blocked: false, message: "" };
  return {
    blocked: true,
    message:
      `refusing ${shape.hookBypass} — the repository's git hooks are its commit/push gate and are not skipped by the agent. ` +
      "Run the command without the bypass and fix whatever the hook reports. If the user explicitly wants the hooks skipped, they approve it in the safety prompt.",
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
  const entry = getEntry(sessionKey);
  if (success) {
    entry.failedVerifies.delete(canonical);
  } else {
    entry.failedVerifies.set(canonical, Date.now());
  }
}

/** A required test gate (shape-compatible with run-gate.ts `GateEntry`). */
export interface RequiredTestGate {
  id: string;
  command: string;
}

export interface PushGateContext {
  /** Directory the push runs in; gate commands are relative to it (as for run_gate). */
  cwd: string;
  /** The recipe's required test gates (style gates excluded unless blocking). */
  requiredGates: RequiredTestGate[];
  /** Where the gates came from (manifest path / disk derivation), for messages. */
  gateSource: string;
}

export type MissingGateReason = "never-run" | "failed" | "stale" | "masked";

export interface MissingGate {
  id: string;
  command: string;
  reason: MissingGateReason;
}

export interface PushGateResult {
  blocked: boolean;
  /** Canonical commands that failed and gate the push. */
  failed: string[];
  /** Required test gates with no valid pass since the last write. */
  missing: MissingGate[];
  /** Set when the push is allowed but no test gate could be detected. */
  warning?: string;
}

/**
 * Commands equivalent to a gate: the gate itself, plus the package.json script
 * body for `npm|pnpm|yarn [run] <script>` / `bun run <script>` gates (so a
 * model running `bunx vitest run` satisfies a `bun run test` gate whose script
 * IS `bunx vitest run`). `bun test` is bun's built-in runner, not a script.
 */
function gateEquivalents(dir: string, command: string): string[] {
  const out = [normalizeCommandText(command)];
  const m = command.trim().match(/^(?:(?:npm|pnpm|yarn)(?:[ \t]+run(?:-script)?)?|bun[ \t]+run)[ \t]+([\w:.-]+)$/);
  if (!m) return out;
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return out;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    const body = pkg.scripts?.[m[1]!];
    if (typeof body === "string" && body.trim()) out.push(normalizeCommandText(body));
  } catch (err) {
    logger.file("warn", "orchestrator", "[git-safety] package.json script lookup failed", {
      operation: "gateEquivalents",
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

function evaluateGate(entry: GitSafetyEntry | undefined, cwd: string, gate: RequiredTestGate): MissingGate | null {
  const parsed = parseRunClauses(gate.command, cwd);
  const target = parsed.clauses[parsed.clauses.length - 1];
  if (!target) return { ...gate, reason: "never-run" };
  const dirKey = normalizeSafetyPath(target.dir);
  const commands = new Set(gateEquivalents(target.dir, target.command));
  let best: RunRecord | null = null;
  for (const rec of entry?.runs.values() ?? []) {
    if (normalizeSafetyPath(rec.dir) !== dirKey || !commands.has(rec.command)) continue;
    if (
      !best ||
      Math.max(rec.passSeq, rec.failSeq, rec.maskedPassSeq) > Math.max(best.passSeq, best.failSeq, best.maskedPassSeq)
    )
      best = rec;
  }
  const lastWrite = entry?.lastWriteSeq ?? 0;
  if (!best) return { ...gate, reason: "never-run" };
  if (best.passSeq > 0 && best.passSeq > best.failSeq && best.passSeq > lastWrite) return null;
  if (best.failSeq > 0 && best.failSeq >= best.passSeq && best.failSeq >= best.maskedPassSeq)
    return { ...gate, reason: "failed" };
  if (best.maskedPassSeq > best.passSeq && best.maskedPassSeq > lastWrite) return { ...gate, reason: "masked" };
  return { ...gate, reason: best.passSeq > 0 || best.maskedPassSeq > 0 ? "stale" : "never-run" };
}

/**
 * The push gate. Without `ctx` (not a git repository, or a caller with no
 * catalog) only the legacy failed-verify rule applies. With `ctx`, every
 * required test gate must have a pass that STARTED after the last native write.
 */
export function checkPushGate(sessionKey: string, ctx?: PushGateContext): PushGateResult {
  if (process.env.MUONROI_ALLOW_PUSH_ON_RED === "1") return { blocked: false, failed: [], missing: [] };
  const entry = getState().get(sessionKey);
  const failed = [...(entry?.failedVerifies.keys() ?? [])];
  if (!ctx) return { blocked: failed.length > 0, failed, missing: [] };
  if (ctx.requiredGates.length === 0) {
    return {
      blocked: failed.length > 0,
      failed,
      missing: [],
      warning: `no test gate detected in the verify recipe (${ctx.gateSource}); the push is not backed by a test run.`,
    };
  }
  const missing = ctx.requiredGates
    .map((gate) => evaluateGate(entry, ctx.cwd, gate))
    .filter((m): m is MissingGate => m !== null);
  return { blocked: failed.length > 0 || missing.length > 0, failed, missing };
}

const MISSING_REASON_TEXT: Record<MissingGateReason, string> = {
  "never-run": "no run recorded this session",
  failed: "its last run FAILED",
  stale: "last pass predates your latest file edit",
  masked: "last run was piped/chained (`|`, `;`, `||`), which hides its exit code",
};

/** Message returned in place of running a blocked `git push`. Names what to run. */
export function pushBlockedMessage(result: PushGateResult | string[]): string {
  const gate: PushGateResult = Array.isArray(result) ? { blocked: true, failed: result, missing: [] } : result;
  const lines = ["refusing to run `git push`."];
  if (gate.missing.length > 0) {
    lines.push("The project's test gate has not passed since your last file edit:");
    for (const m of gate.missing) lines.push(`  • ${m.id} \`${m.command}\` — ${MISSING_REASON_TEXT[m.reason]}`);
    lines.push(
      "Run each command above as its own bash call (no pipe, `;` or `||`), or `run_gate gate=<id>` where available; " +
        "wait for it to pass with 0 failures, then push.",
    );
  }
  if (gate.failed.length > 0) {
    lines.push("These verification commands failed this session and have not passed since:");
    for (const c of gate.failed) lines.push(`  • ${c}`);
    lines.push("Re-run each until it passes (0 failures), then push.");
  }
  lines.push(
    "Never push on red. If the user explicitly wants to push anyway, they approve it in the safety prompt " +
      "(or set MUONROI_ALLOW_PUSH_ON_RED=1).",
  );
  return lines.join("\n");
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

// ── Foreign-path broad staging (M3) ──────────────────────────────────────────
//
// `git add -A` / `.` / `-u` / `commit -a` sweep EVERY dirty path into the
// commit — including the user's unrelated work-in-progress and the CLI's own
// artifacts. Refuse it while any dirty path in scope was not written by this
// session's native file tools, and name the explicit `git add` that is safe.

const GIT_STATUS_TIMEOUT_MS = 8000;

/** `git` with optional-locks off, so a status probe never contends for index.lock. */
function gitRaw(cwd: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_STATUS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (r.error) return { ok: false, stdout: "", error: r.error.message };
    return { ok: r.status === 0, stdout: r.stdout ?? "", error: r.status === 0 ? undefined : String(r.stderr ?? "") };
  } catch (err) {
    return { ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Repository top level containing `cwd`, or null outside a git work tree. */
export function gitTopLevel(cwd: string): string | null {
  const r = gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
  const top = r.stdout.trim();
  return r.ok && top ? path.resolve(normalizeMsysDrivePath(top)) : null;
}

export interface DirtyPath {
  /** Repo-relative, forward slashes. */
  rel: string;
  untracked: boolean;
}

/** Dirty paths (`git status --porcelain -z --untracked-files=all`), renames by NEW path. */
export function listDirtyPaths(root: string): DirtyPath[] | null {
  const r = gitRaw(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!r.ok) {
    logger.file("warn", "orchestrator", "[git-safety] git status failed", {
      operation: "listDirtyPaths",
      root,
      error: r.error,
    });
    return null;
  }
  const tokens = r.stdout.split("\0");
  const out: DirtyPath[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    out.push({ rel: token.slice(3), untracked: xy === "??" });
    if (/[RC]/.test(xy)) i++; // skip the rename/copy SOURCE token
  }
  return out;
}

export interface ForeignStagingResult {
  blocked: boolean;
  /** Dirty paths in scope this session did not write (repo-relative). */
  foreign: string[];
  /** Dirty paths in scope this session DID write (repo-relative). */
  own: string[];
  message: string;
}

export function checkForeignStaging(sessionKey: string, cwd: string, shape: GitCommandShape): ForeignStagingResult {
  const none: ForeignStagingResult = { blocked: false, foreign: [], own: [], message: "" };
  if (!shape.broadStageScope || process.env.MUONROI_ALLOW_BROAD_STAGE === "1") return none;
  const root = gitTopLevel(cwd);
  if (!root) return none;
  const dirty = listDirtyPaths(root);
  if (!dirty) return none; // logged; fail open — the commit LSP gate + sensitive check still apply
  const written = new Set(sessionWrittenPaths(sessionKey).map((p) => canonicalSafetyPath(p)));
  const cwdKey = canonicalSafetyPath(cwd);
  const foreign: string[] = [];
  const own: string[] = [];
  for (const d of dirty) {
    if (shape.broadStageScope === "tracked" && d.untracked) continue;
    const abs = canonicalSafetyPath(d.rel, root);
    if (shape.broadStageScope === "cwd" && abs !== cwdKey && !abs.startsWith(`${cwdKey}${path.sep}`)) continue;
    // --untracked-files=all lists files, never collapsed directories, so an
    // exact path match is complete.
    (written.has(abs) ? own : foreign).push(d.rel);
  }
  if (foreign.length === 0) return { ...none, own };
  const shown = foreign.slice(0, 30).map((p) => `  • ${p}`);
  if (foreign.length > 30) shown.push(`  … and ${foreign.length - 30} more`);
  const explicit = own.length
    ? `Stage only your own files explicitly, e.g. \`git add -- ${own.slice(0, 10).join(" ")}\`${own.length > 10 ? " …" : ""}, or use the git_commit tool (it stages exactly the files you wrote).`
    : "Stage the specific files you mean with `git add -- <path>`, or use the git_commit tool (it stages exactly the files you wrote).";
  return {
    blocked: true,
    foreign,
    own,
    message:
      "refusing broad staging (`git add -A`/`.`/`-u`/`commit -a`) — these dirty paths were NOT written by you this session " +
      "and would be swept into the commit:\n" +
      `${shown.join("\n")}\n\n` +
      `${explicit} Leave the paths above alone unless the user asked to commit them; if so, the user approves it in the safety prompt.`,
  };
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
