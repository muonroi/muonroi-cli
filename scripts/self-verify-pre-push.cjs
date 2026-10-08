#!/usr/bin/env node
/**
 * scripts/self-verify-pre-push.cjs
 *
 * Runs `bun run src/index.ts self-verify` BEFORE `git push` only when the
 * commits being pushed touch UI / harness surfaces — files where vitest
 * unit tests cannot catch lifecycle, modal, askcard, or focus bugs.
 *
 * Skip with:  git push --no-verify
 * Opt out:    SELF_VERIFY_PRE_PUSH=0 git push
 *
 * Cost: ~30s + ~$0.005-0.01 per run when a watched surface changed,
 * zero cost otherwise.
 *
 * ── Base ref (round 8) ───────────────────────────────────────────────────
 * This used to hardcode `${remote}/master` as the diff base regardless of
 * what was actually being pushed. On THIS repo `origin/master` is a
 * long-stale ref, so diffing any `develop`-based branch against it picked
 * up hundreds of unrelated files, including — by coincidence — files under
 * WATCH_DIRS, tripping self-verify for pushes that touched none of them.
 *
 * `.husky/pre-push` invokes this script as a plain foreground command with
 * no stdin redirection, so it inherits the pre-push hook's own stdin
 * verbatim: git's pre-push protocol writes one line per pushed ref,
 * `<local ref> SP <local sha1> SP <remote ref> SP <remote sha1>` (see
 * githooks(5)). `selectBaseRef` (exported for the unit test) is the pure
 * per-line decision:
 *   - local sha1 all-zero → a ref DELETION, nothing was pushed, nothing to
 *     diff (checked first — a delete can carry a real, non-zero remote
 *     sha1 for the ref being removed).
 *   - remote sha1 non-zero (the ref already exists on the remote) → that
 *     sha1 IS the base.
 *   - remote sha1 all-zero (a brand-new remote branch) → `resolveFallbackBase`:
 *     merge-base with the remote's own default/integration branch, tried
 *     `<remote>/develop`, else `<remote>/HEAD`, else `<remote>/master`
 *     (last resort, never used first, never a hardcoded master outright).
 *
 * ── Never fail open on an undiffable ref (round 9) ──────────────────────
 * Round 8's "could not diff → skip" fallback was itself a fail-open hole:
 * a remote sha that exists on the remote but is not yet fetched locally
 * (a stale remote-tracking ref, a shallow clone, a first-time fetch of
 * that branch) made `git diff <remoteSha>...<localSha>` throw. The catch
 * swallowed it, contributed nothing to `touched`, and — if no OTHER pushed
 * ref happened to touch a watched dir — the whole run fell through to "no
 * UI/harness/self-qa changes detected", skipping self-verify for a push
 * that may have touched exactly those files. An unfetched remote sha is
 * the ordinary case, not a corrupt one, so it must never silently read as
 * "clean".
 *
 * `ensureDiffable` now makes a real object-presence check
 * (`git cat-file -e <sha>^{commit}`) before ever trying to diff a remote
 * sha, and — only if that fails — ONE quiet `git fetch --no-tags <remote>
 * <remoteRef>` attempt (ignored if the remote refuses; never a hard
 * error) before rechecking. `decideSelfVerify` (exported, pure) is the
 * decision across every pushed ref's outcome, and never fails open:
 *   - any ref whose diff actually touched a watched dir wins outright —
 *     run self-verify using THAT ref's base (not merely the first ref
 *     that happened to resolve a base at all).
 *   - otherwise, if any ref's diff could not be computed even after the
 *     fetch retry → FAIL CLOSED: treat it as "watched surfaces may have
 *     changed" and run self-verify anyway, using a fallback base
 *     (`resolveFallbackBase` against the remote's own develop/HEAD/master,
 *     same candidate order as the new-branch case) as the `--since` arg,
 *     logging why.
 *   - only when every ref's diff was actually computed, and none touched a
 *     watched dir, is this a real "no changes" finding → skip.
 *
 * Manual invocation (no pre-push stdin — e.g. running this script by hand,
 * or from a context that does not pipe git's protocol in) used to read as
 * "could not read the pre-push ref list on stdin — skipping" unconditionally.
 * That is also a fail-open hole with no upside: it now falls back to the
 * pre-round-8 behaviour of diffing HEAD against the resolved fallback base
 * directly, exactly as if HEAD were a brand-new branch push, instead of
 * skipping outright.
 *
 * `PRE_PUSH_REMOTE` and `SELF_VERIFY_PRE_PUSH=0` behave exactly as before.
 * The only remaining "skip, push proceeds" cases are: a pure ref deletion;
 * no candidate base ref resolves for ANY pushed ref, and no empty-tree
 * fallback either (see below); or every ref's diff was actually computed
 * and genuinely touched nothing.
 *
 * ── Fetch cannot hang the push, and never prompts (round 10) ────────────
 * Refuter on round 9: `fetchRefReal`'s `git fetch` had no timeout and no
 * `GIT_TERMINAL_PROMPT=0` — a slow or misbehaving remote (or one that
 * blocks waiting on a credential prompt with no TTY attached) could hang
 * `git push` forever, since this script runs synchronously inside the
 * pre-push hook. It now runs with a bounded `timeout`
 * (`SELF_VERIFY_PRE_PUSH_FETCH_TIMEOUT_MS`, default 20000ms) and
 * `killSignal: "SIGKILL"`, and with `GIT_TERMINAL_PROMPT=0` /
 * `GIT_ASKPASS=""` / `SSH_ASKPASS=""` / a `GIT_SSH_COMMAND` that adds
 * `-oBatchMode=yes` ONLY when the user has not already set one (an
 * existing `GIT_SSH_COMMAND` is used verbatim, never overwritten) so the
 * fetch can never block on a prompt either. A timed-out or killed fetch
 * is just another "still undiffable" outcome — it flows into the exact
 * same fail-CLOSED path as a fetch that completes but doesn't help.
 * NOTE (LOW): fetching `<remote> <remoteRef>` with no destination refspec
 * still updates this repo's own remote-tracking ref for it (e.g.
 * `refs/remotes/<remote>/<branch>`) when the remote's configured fetch
 * refspec matches — this diff-only helper has that one side effect on the
 * local repo, same as running `git fetch <remote> <ref>` by hand would.
 *
 * ── No known integration branch at all (round 10, optional closure) ─────
 * If NOTHING resolves a base for ANY pushed ref — not even the
 * develop/HEAD/master fallback (e.g. a repo with no such remote branches
 * fetched yet) — round 9 skipped outright. That both-lists-empty case now
 * diffs the anchor commit against the git empty tree
 * (`git hash-object -t tree /dev/null`) instead: every file in that commit
 * counts as "changed", so a watched file still trips self-verify instead
 * of silently reading as clean for want of ANY comparison point.
 *
 * ── The empty-tree fallback was itself dead, and had a second fail-open
 *    hole underneath it (round 11) ────────────────────────────────────────
 * Refuter on round 10: `diffNames` runs `git diff a...b` — a triple-dot
 * SYMMETRIC-DIFFERENCE/merge-base range expression, which only accepts
 * commit-ish operands. Handed the empty TREE object as `a`, git fails with
 * "Invalid symmetric difference expression": the round-10 empty-tree
 * fallback was marked `undiffable` on every single use, never actually
 * diffed anything. And because `decideSelfVerify`'s "undiffable, no
 * fallback base" branch still returned `run: false`, that undiffable
 * result silently SKIPPED self-verify — fail open, despite the log line
 * claiming otherwise. Fixed two ways:
 *   - `diffNamesFromTree(tree, head)` uses the plain two-argument diff
 *     form (`git diff a b`, no dots) instead, which accepts a bare tree.
 *   - `decideSelfVerify`'s last resort no longer skips: "undiffable, no
 *     fallback base resolved either" now also runs self-verify.
 *
 * ── Omitting `--since` does not mean "check everything" (round 12) ──────
 * Refuter on round 11: `bun run src/index.ts self-verify` with NO `--since`
 * does not check everything — `src/index.ts`'s own `--since` option DEFAULTS
 * to `"HEAD~1"` (and `scenario-planner.ts`'s `planScenarios` defaults its
 * `baseRef` to `"HEAD~1"` too), so round 11's `base: null` (omit `--since`)
 * silently only compared the TIP commit to its own parent. A multi-commit
 * push whose UI change lives in an EARLIER, non-tip commit was invisible to
 * self-verify's own scenario planning — the pre-push script logged "failing
 * closed", but the thing it invoked quietly checked almost nothing.
 *
 * Checked the sibling case too: does self-verify's planner choke on a TREE
 * passed as `--since` (the empty-tree base already used elsewhere in this
 * file)? No — `scenario-planner.ts`'s `collectChangedFiles` runs
 * `git diff --name-only <baseRef> --`, a PLAIN SINGLE-OPERAND diff (working
 * tree vs. that ref), never a `...`/`..` range, so it accepts a bare tree
 * exactly like `diffNamesFromTree` above (verified: `git diff --name-only
 * <emptyTreeSha> --` in a real repo lists every tracked file, no error).
 * The empty tree is therefore both correct AND already safe to hand to the
 * real planner as-is — no planner change needed, "fix in one place".
 *
 * Every "check everything" outcome now ALWAYS passes a real `--since`
 * value, chosen in this priority: the empty tree
 * (`emptyTreeShaReal`, reused from round 10 — the most robust: a genuine
 * from-scratch diff, immune to the "root commit's own untouched files
 * never show as changed" gap a real commit base would have), else the
 * root commit of HEAD (`git rev-list --max-parents=0 HEAD`; several roots
 * → the first one, logged) if `hash-object` itself somehow fails. Only if
 * BOTH fail (git itself is broken) does this fall back to omitting
 * `--since` as an absolute last resort — a defensive fallback that should
 * be unreachable in practice, kept rather than crashing.
 * The only `run: false` outcomes left are a deletion-only push (nothing
 * to check, ever) and every diff actually computed with nothing touched.
 */
"use strict";

const { execSync, spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const WATCH_DIRS = ["src/ui/", "src/self-qa/", "src/agent-harness/", "packages/agent-harness-"];
const ZERO_SHA = "0".repeat(40);

function log(msg) {
  process.stderr.write(`[self-verify-pre-push] ${msg}\n`);
}

function exitWith(code) {
  process.exit(code);
}

function isZero(sha) {
  return !sha || sha === ZERO_SHA;
}

/**
 * Fallback base when there is no remote sha to diff against directly (a
 * brand-new remote branch, an undiffable remote sha, or a manual/no-stdin
 * invocation): merge-base of `head` with the remote's own integration
 * branch, tried `<remote>/develop`, else `<remote>/HEAD`, else
 * `<remote>/master` — never a hardcoded master alone.
 */
function resolveFallbackBase(remote, head, refExists, mergeBase) {
  const candidates = [`${remote}/develop`, `${remote}/HEAD`, `${remote}/master`];
  for (const candidate of candidates) {
    if (!refExists(candidate)) continue;
    const mb = mergeBase(head, candidate);
    if (mb) return mb;
  }
  return null;
}

/**
 * Pure base-ref decision for ONE pushed ref line — no I/O of its own;
 * `refExists`/`mergeBase` are injected so this is unit-testable without a
 * real git repo. Returns the sha/ref to diff FROM, or `null` when none can
 * be determined for THIS ref (the caller still may not skip overall — see
 * `decideSelfVerify`).
 */
function selectBaseRef({ localSha, remoteSha, remote, refExists, mergeBase }) {
  if (isZero(localSha)) {
    return null; // a ref DELETION (checked first — a delete can carry a real, non-zero remote sha too) — nothing pushed, nothing to diff
  }
  if (!isZero(remoteSha)) {
    return remoteSha;
  }
  return resolveFallbackBase(remote, localSha, refExists, mergeBase);
}

/** Parse git's pre-push stdin protocol: one `<local ref> <local sha1> <remote ref> <remote sha1>` line per pushed ref. */
function parsePushLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 4) return null;
      const [localRef, localSha, remoteRef, remoteSha] = parts;
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((l) => l !== null);
}

/** Read every pushed-ref line from stdin. Never throws; empty array on any failure (no TTY stdin, closed early, etc). */
function readPushLines() {
  if (process.stdin.isTTY) return [];
  try {
    return parsePushLines(readFileSync(0, "utf8"));
  } catch {
    return [];
  }
}

function refExistsReal(ref) {
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { encoding: "utf8", stdio: "pipe" });
  return r.status === 0;
}

function mergeBaseReal(a, b) {
  const r = spawnSync("git", ["merge-base", a, b], { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) return null;
  const sha = (r.stdout || "").trim();
  return sha || null;
}

function diffNames(base, head) {
  return execSync(`git diff --name-only ${base}...${head}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Diff a TREE object (not a commit) against a commit. `git diff a...b`
 * (triple-dot) is a symmetric-difference / merge-base range expression and
 * only accepts commit-ish operands — with a bare tree (e.g. the empty
 * tree) as `a`, it fails with "Invalid symmetric difference expression".
 * The plain two-argument form (`git diff a b`, no dots) is a direct
 * tree-vs-tree/commit diff and accepts a tree on either side.
 */
function diffNamesFromTree(tree, head) {
  return execSync(`git diff --name-only ${tree} ${head}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Is `sha` a commit object already present in the local object store? */
function commitAvailableReal(sha) {
  const r = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "pipe" });
  return r.status === 0;
}

const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function fetchTimeoutMs() {
  const raw = process.env.SELF_VERIFY_PRE_PUSH_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FETCH_TIMEOUT_MS;
}

/**
 * One quiet, best-effort, BOUNDED fetch of a single ref. Never hangs the
 * push (a bounded `timeout` + `SIGKILL`) and never prompts (no TTY is
 * attached in a hook, so a credential/host-key prompt would hang exactly
 * like a slow network — `GIT_TERMINAL_PROMPT=0`/empty askpass vars, and a
 * `GIT_SSH_COMMAND` batch-mode default that never overwrites the user's
 * own). A remote that refuses (auth, network, unknown ref, or a timeout)
 * never throws — the caller's recheck is what matters, not this exit code.
 */
function fetchRefReal(remote, remoteRef) {
  const timeoutMs = fetchTimeoutMs();
  log(`fetching ${remoteRef} from ${remote} to diff against it (timeout ${Math.round(timeoutMs / 1000)}s)`);
  const existingSshCommand = process.env.GIT_SSH_COMMAND;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: existingSshCommand?.trim() ? existingSshCommand : "ssh -oBatchMode=yes",
  };
  const r = spawnSync("git", ["fetch", "--no-tags", "--quiet", remote, remoteRef], {
    stdio: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env,
  });
  return r.status === 0;
}

/** The empty-tree object id (`git hash-object -t tree /dev/null`) — computed rather than hardcoded so this works on any hash algorithm the repo uses. */
function emptyTreeShaReal() {
  const r = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) return null;
  const sha = (r.stdout || "").trim();
  return sha || null;
}

/**
 * The root commit of HEAD's history (`git rev-list --max-parents=0 HEAD`) —
 * the fallback-of-the-fallback "check everything" base, used only if the
 * empty tree itself could not be computed (git badly broken). Several
 * roots (a grafted/merged-in history) → the first one, logged, since any
 * one root is a valid anchor for "diff since the beginning".
 */
function rootCommitShaReal() {
  const r = spawnSync("git", ["rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) return null;
  const lines = (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length > 1) {
    log(`HEAD has ${lines.length} root commits (a grafted or merged-in history) — using the first: ${lines[0]}`);
  }
  return lines[0];
}

/**
 * Ensures `sha` is diffable locally before it is ever used as a diff base.
 * A remote sha that is not yet fetched is the ORDINARY case (stale
 * remote-tracking ref, shallow clone, first push of this branch), not a
 * corrupt one — so a missing object gets exactly one quiet fetch attempt
 * of `remoteRef` before giving up. `commitAvailable`/`fetchRef` are
 * injected for testing against real temp repos without hardcoding git's
 * real binary path.
 */
function ensureDiffable(sha, remote, remoteRef, { commitAvailable, fetchRef }) {
  if (commitAvailable(sha)) return true;
  fetchRef(remote, remoteRef || "HEAD"); // best-effort; ignore the result either way, recheck is authoritative
  return commitAvailable(sha);
}

/**
 * Pure decision across every pushed ref's outcome — never fails open.
 * `results` is `Array<{ base: string, touched: string[], undiffable: boolean }>`,
 * one entry per pushed ref whose base COULD be selected (deletions and
 * refs with no resolvable base at all are excluded before this point).
 * `fallbackBase` is the develop/HEAD/master merge-base against the anchor
 * commit, precomputed once, used only for the fail-closed case.
 * `checkEverythingBase` (round 12) is a REAL, always-diffable "check
 * everything" value — the empty tree, or the root commit if even that
 * could not be computed — used ONLY as the very last resort, so this never
 * has to omit `--since` (which self-verify's own CLI/planner would then
 * silently default to `HEAD~1`, not "everything").
 *
 *   - a ref whose diff actually touched a watched dir wins outright: run,
 *     using ITS base (not merely the first ref that happened to resolve).
 *   - no ref touched anything, but at least one ref's diff could not be
 *     computed (an undiffable remote sha even after the fetch retry) →
 *     FAIL CLOSED: cannot rule out a watched change, so run self-verify
 *     anyway, using `fallbackBase` as the `--since` argument when one
 *     resolved, else `checkEverythingBase` (round 12: this used to be
 *     `base: null` / omit `--since` — a fail-open hole, since that is NOT
 *     "everything" from self-verify's own point of view), else — only if
 *     NEITHER resolved — `base: null` as an unreachable-in-practice last
 *     resort. There is no comparison point left to trust, so trusting
 *     "clean" is not an option.
 *   - otherwise: every ref's diff was actually computed and none touched a
 *     watched dir → skip, the only case that is a real "no changes" finding.
 *
 * The only remaining `run: false` outcomes are therefore: a deletion-only
 * push (nothing reaches `results` at all and `fallbackBase`/`checkEverythingBase`
 * are null because there was no anchor commit either), or every diff was
 * actually computed and genuinely touched nothing.
 */
function decideSelfVerify(results, fallbackBase, checkEverythingBase) {
  const touching = results.find((r) => !r.undiffable && r.touched.length > 0);
  if (touching) {
    return { run: true, base: touching.base, touched: touching.touched, reason: "watched surface changed" };
  }

  const anyUndiffable = results.some((r) => r.undiffable);
  if (anyUndiffable) {
    if (fallbackBase) {
      return {
        run: true,
        base: fallbackBase,
        touched: [],
        reason: "a pushed ref's diff could not be computed even after a fetch retry — failing closed",
      };
    }
    if (checkEverythingBase) {
      return {
        run: true,
        base: checkEverythingBase,
        touched: [],
        reason:
          "a pushed ref's diff could not be computed and no fallback base resolved either — failing closed against everything",
      };
    }
    return {
      run: true,
      base: null,
      touched: [],
      reason:
        "a pushed ref's diff could not be computed, and neither a fallback base nor a check-everything base resolved — failing closed with --since omitted (last resort; self-verify's own default is HEAD~1, not everything)",
    };
  }

  if (results.length === 0) {
    return {
      run: false,
      base: null,
      touched: [],
      reason:
        "no pushed ref to diff (deletion-only push, or nothing resolved anything to check) — skipping (push will proceed)",
    };
  }

  return { run: false, base: null, touched: [], reason: "no UI/harness/self-qa changes detected" };
}

// Exported for the unit test (vitest imports this file as a plain module via
// require() — the block below runs ONLY when this file is executed directly,
// the way `.husky/pre-push` does, never on a bare require()).
module.exports = { selectBaseRef, resolveFallbackBase, decideSelfVerify, selfVerifyArgs, parsePushLines, ZERO_SHA };

/** Builds the self-verify args; omits `--since` entirely when there is no trustworthy base left to diff against (checks everything). */
function selfVerifyArgs(sinceBase) {
  const args = ["run", "src/index.ts", "self-verify", "--max", "4", "--no-emit"];
  if (sinceBase) args.splice(3, 0, "--since", sinceBase);
  return args;
}

function runSelfVerify(sinceBase) {
  const result = spawnSync("bun", selfVerifyArgs(sinceBase), {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status;
}

function reportOutcome(status, sinceBase) {
  if (status === 0) {
    log("self-verify PASSED — proceeding with push");
    exitWith(0);
  }

  // Exit codes are the contract in `selfVerifyExitCode` (src/self-qa/index.ts):
  // 1 = an expectation failed, 3 = nothing failed but nothing was established.
  // Both block. Reporting them differently matters because the fix differs: a
  // regression is in your change, an inconclusive is usually in the harness.
  if (status === 3) {
    log("self-verify INCONCLUSIVE — no scenario failed, but at least one verified NOTHING");
    log("this is not a pass: the gate could not establish that your change works");
    log("the INCONCLUSIVE line above names the scenario; read its first '·' line for why —");
    log("  'Child never became ready' = the TUI child did not come up, NOT a defect in your");
    log("  change (it names the gate it waited on, the budget, the measured wait, whether the");
    log("  child was alive, and the child's stderr tail). Re-run it directly to confirm:");
    log(`  bun ${selfVerifyArgs(sinceBase).join(" ")}`);
  } else {
    log(`self-verify FAILED (exit ${status}) — an expectation was measured and MISSED`);
    log("the FAIL line above names the scenario and the expectation; this one is in your change");
  }
  log("override with: git push --no-verify");
  exitWith(1);
}

function main() {
  if (process.env.SELF_VERIFY_PRE_PUSH === "0") {
    log("disabled via SELF_VERIFY_PRE_PUSH=0 — skipping");
    exitWith(0);
  }

  let remote = "origin";
  try {
    remote =
      process.env.PRE_PUSH_REMOTE ||
      execSync("git remote", { encoding: "utf8" })
        .split(/\r?\n/)
        .find((l) => l.trim()) ||
      "origin";
    remote = remote.trim();
  } catch {
    // fallback already set
  }

  let pushLines = readPushLines();
  let manualInvocation = false;
  if (pushLines.length === 0) {
    // No real pre-push stdin (manual invocation, or a context that does not
    // pipe git's protocol in). Round 8 skipped outright here — a fail-open
    // hole with no upside. Fall back to the pre-round-8 behaviour: diff
    // HEAD against the resolved fallback base directly, as if HEAD were a
    // brand-new branch push, instead of skipping unconditionally.
    manualInvocation = true;
    let headSha = null;
    try {
      headSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      headSha = null;
    }
    if (!headSha) {
      log(
        "could not read the pre-push ref list on stdin, and could not resolve HEAD either — skipping (push will proceed)",
      );
      exitWith(0);
    }
    pushLines = [{ localRef: "HEAD", localSha: headSha, remoteRef: "HEAD", remoteSha: ZERO_SHA }];
  }

  const results = [];
  for (const { localSha, remoteSha, remoteRef } of pushLines) {
    if (isZero(localSha)) continue; // a ref DELETION — nothing pushed, nothing to diff, no vote either way

    const base = selectBaseRef({ localSha, remoteSha, remote, refExists: refExistsReal, mergeBase: mergeBaseReal });
    if (!base) continue; // no candidate base resolved for THIS ref — it contributes nothing (not itself a fail signal)

    const usesRemoteShaDirectly = !isZero(remoteSha) && base === remoteSha;
    if (usesRemoteShaDirectly) {
      const diffable = ensureDiffable(base, remote, remoteRef, {
        commitAvailable: commitAvailableReal,
        fetchRef: fetchRefReal,
      });
      if (!diffable) {
        log(
          `remote sha ${base} is not available locally even after "git fetch ${remote} ${remoteRef}" — will fail closed unless another pushed ref proves clean`,
        );
        results.push({ base, touched: [], undiffable: true });
        continue;
      }
    }

    let changed;
    try {
      changed = diffNames(base, localSha);
    } catch {
      log(
        `could not diff against ${base} even though the commit is available — will fail closed unless another pushed ref proves clean`,
      );
      results.push({ base, touched: [], undiffable: true });
      continue;
    }
    const touched = changed
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f && WATCH_DIRS.some((d) => f.startsWith(d)));
    results.push({ base, touched, undiffable: false });
  }

  // The fail-closed / manual-invocation fallback base is resolved against
  // the first pushed ref's own local sha — any pushed commit is an equally
  // valid anchor for "what does HEAD's own history look like relative to
  // the remote's integration branch".
  const anchorSha = pushLines.find((l) => !isZero(l.localSha))?.localSha ?? null;

  // Computed once, up front, whenever there is anything to check at all:
  // reused both by the "no candidate base at all" block below AND as
  // `decideSelfVerify`'s last-resort "check everything" argument, so both
  // paths agree on the same real, always-diffable value instead of ever
  // falling back to omitting `--since` (which is NOT "everything" from
  // self-verify's own CLI's point of view — see the round-12 header note).
  const emptyTree = anchorSha ? emptyTreeShaReal() : null;
  const checkEverythingBase = emptyTree ?? (anchorSha ? rootCommitShaReal() : null);

  if (results.length === 0 && anchorSha) {
    // No candidate base resolved for ANY pushed ref — not even the
    // develop/HEAD/master fallback (no known integration branch fetched
    // locally at all). Diff against the empty tree instead of giving up:
    // every file in the anchor commit counts as "changed", so a watched
    // file still trips self-verify rather than reading as clean for want
    // of ANY comparison point.
    if (emptyTree) {
      log(
        `no local candidate base ref resolved for any pushed ref — diffing against the empty tree instead of skipping blind`,
      );
      try {
        // `git diff a...b` (triple-dot) is a commit-ish range expression and
        // rejects a bare tree operand — use the plain two-argument tree diff.
        const changed = diffNamesFromTree(emptyTree, anchorSha);
        const touched = changed
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter((f) => f && WATCH_DIRS.some((d) => f.startsWith(d)));
        results.push({ base: emptyTree, touched, undiffable: false });
      } catch {
        results.push({ base: emptyTree, touched: [], undiffable: true });
      }
    } else if (checkEverythingBase) {
      // hash-object itself failed but the root-commit fallback resolved —
      // this IS a real commit, so the ordinary triple-dot diffNames is fine.
      log(
        "no local candidate base ref resolved for any pushed ref, and the empty-tree object id could not be computed — diffing against HEAD's root commit instead",
      );
      try {
        const changed = diffNames(checkEverythingBase, anchorSha);
        const touched = changed
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter((f) => f && WATCH_DIRS.some((d) => f.startsWith(d)));
        results.push({ base: checkEverythingBase, touched, undiffable: false });
      } catch {
        results.push({ base: checkEverythingBase, touched: [], undiffable: true });
      }
    } else {
      log(
        "no local candidate base ref resolved for any pushed ref, and neither the empty-tree object id nor a root commit could be computed either",
      );
      results.push({ base: null, touched: [], undiffable: true });
    }
  }

  const fallbackBase = anchorSha ? resolveFallbackBase(remote, anchorSha, refExistsReal, mergeBaseReal) : null;

  const decision = decideSelfVerify(results, fallbackBase, checkEverythingBase);
  log(decision.reason + (manualInvocation ? " (manual invocation — no pre-push stdin)" : ""));
  if (decision.touched.length > 0) {
    log(`(${decision.touched.length} file(s))`);
    for (const f of decision.touched.slice(0, 5)) log(`  · ${f}`);
    if (decision.touched.length > 5) log(`  · …and ${decision.touched.length - 5} more`);
  }
  if (!decision.run) {
    exitWith(0);
  }

  const status = runSelfVerify(decision.base);
  reportOutcome(status, decision.base);
}

if (require.main === module) {
  main();
}
