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
 * ── Base ref (round 8 fix) ──────────────────────────────────────────────
 * This used to hardcode `${remote}/master` as the diff base regardless of
 * what was actually being pushed. On THIS repo `origin/master` is a
 * long-stale ref (its merge-base with `origin/develop` is far behind
 * `origin/develop`'s own tip) — diffing any `develop`-based branch against
 * it picks up hundreds of files of unrelated, already-integrated history,
 * including — by coincidence, not because the pushed branch touched them —
 * files under the WATCH_DIRS below. A push that touched ZERO UI/harness
 * files then still triggered self-verify, and the scenario it picked
 * (chosen from THAT bogus diff) had nothing to do with the actual change.
 *
 * `.husky/pre-push` invokes this script as a plain foreground command with
 * no stdin redirection, so it inherits the pre-push hook's own stdin
 * verbatim: git's pre-push protocol writes one line per pushed ref,
 * `<local ref> SP <local sha1> SP <remote ref> SP <remote sha1>` (see
 * githooks(5)), before waiting for this process to exit. `selectBaseRef`
 * (exported for the unit test) is the pure decision per line:
 *   - local sha1 all-zero → a ref DELETION, nothing was pushed, nothing to
 *     diff (checked first — a delete can carry a real, non-zero remote
 *     sha1 for the ref being removed, which must NOT be mistaken for "the
 *     ref already exists, diff from there").
 *   - remote sha1 non-zero (the ref already exists on the remote) → that
 *     sha1 IS the base — diff exactly what this push would move the ref by.
 *   - remote sha1 all-zero (a brand-new remote branch, e.g. this repo's
 *     first push of a feature branch) → there is no remote state to diff
 *     against, so fall back to a merge-base with the remote's own
 *     default/integration branch, tried in order: `<remote>/develop` (this
 *     repo's actual integration branch), else `<remote>/HEAD` (whatever the
 *     remote's own default branch is, symbolically), else `<remote>/master`
 *     (last-resort — never used FIRST, unlike before) — never a hardcoded
 *     `master` outright.
 * `PRE_PUSH_REMOTE` and `SELF_VERIFY_PRE_PUSH=0` behave exactly as before.
 * The existing "could not diff → skip, push proceeds" fail-open behaviour
 * is preserved (now also covering "could not read/parse the pre-push stdin
 * lines" and "no candidate base ref resolved") — never loosened further.
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

/**
 * Pure base-ref decision for ONE pushed ref line — no I/O of its own;
 * `refExists`/`mergeBase` are injected so this is unit-testable without a
 * real git repo. Returns the sha/ref to diff FROM, or `null` when none can
 * be determined (caller treats that the same as any other "could not
 * diff" case: skip self-verify for this line, never block the push on it).
 */
function selectBaseRef({ localSha, remoteSha, remote, refExists, mergeBase }) {
  if (!localSha || localSha === ZERO_SHA) {
    return null; // a ref DELETION (checked first — a delete can carry a real, non-zero remote sha too) — nothing pushed, nothing to diff
  }
  if (remoteSha && remoteSha !== ZERO_SHA) {
    return remoteSha;
  }
  const candidates = [`${remote}/develop`, `${remote}/HEAD`, `${remote}/master`];
  for (const candidate of candidates) {
    if (!refExists(candidate)) continue;
    const mb = mergeBase(localSha, candidate);
    if (mb) return mb;
  }
  return null;
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

// Exported for the unit test (vitest imports this file as a plain module via
// require() — the block below runs ONLY when this file is executed directly,
// the way `.husky/pre-push` does, never on a bare require()).
module.exports = { selectBaseRef, parsePushLines, ZERO_SHA };

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

  const pushLines = readPushLines();
  if (pushLines.length === 0) {
    log("could not read the pre-push ref list on stdin — skipping self-verify (push will proceed)");
    exitWith(0);
  }

  const touched = new Set();
  // The base used for the FIRST line that actually resolved — reused as the `--since` arg self-verify itself gets.
  let representativeBase = null;

  for (const { localSha, remoteSha } of pushLines) {
    const base = selectBaseRef({ localSha, remoteSha, remote, refExists: refExistsReal, mergeBase: mergeBaseReal });
    if (!base) continue; // a deletion, or no candidate resolved — this line contributes nothing
    if (!representativeBase) representativeBase = base;

    let changed;
    try {
      changed = diffNames(base, localSha);
    } catch {
      log(`could not diff against ${base} — skipping this ref (push will proceed)`);
      continue;
    }
    for (const f of changed.split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed && WATCH_DIRS.some((d) => trimmed.startsWith(d))) touched.add(trimmed);
    }
  }

  if (!representativeBase) {
    log("could not resolve a base ref for any pushed ref — skipping self-verify (push will proceed)");
    exitWith(0);
  }

  if (touched.size === 0) {
    log("no UI/harness/self-qa changes detected — skipping");
    exitWith(0);
  }

  const touchedList = [...touched];
  log(`watched surface changed (${touchedList.length} file(s)) — running self-verify`);
  for (const f of touchedList.slice(0, 5)) log(`  · ${f}`);
  if (touchedList.length > 5) log(`  · …and ${touchedList.length - 5} more`);

  const result = spawnSync(
    "bun",
    ["run", "src/index.ts", "self-verify", "--since", representativeBase, "--max", "4", "--no-emit"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  if (result.status === 0) {
    log("self-verify PASSED — proceeding with push");
    exitWith(0);
  }

  // Exit codes are the contract in `selfVerifyExitCode` (src/self-qa/index.ts):
  // 1 = an expectation failed, 3 = nothing failed but nothing was established.
  // Both block. Reporting them differently matters because the fix differs: a
  // regression is in your change, an inconclusive is usually in the harness.
  if (result.status === 3) {
    log("self-verify INCONCLUSIVE — no scenario failed, but at least one verified NOTHING");
    log("this is not a pass: the gate could not establish that your change works");
    log("the INCONCLUSIVE line above names the scenario; read its first '·' line for why —");
    log("  'Child never became ready' = the TUI child did not come up, NOT a defect in your");
    log("  change (it names the gate it waited on, the budget, the measured wait, whether the");
    log("  child was alive, and the child's stderr tail). Re-run it directly to confirm:");
    log(`  bun run src/index.ts self-verify --since ${representativeBase} --max 4 --no-emit`);
  } else {
    log(`self-verify FAILED (exit ${result.status}) — an expectation was measured and MISSED`);
    log("the FAIL line above names the scenario and the expectation; this one is in your change");
  }
  log("override with: git push --no-verify");
  exitWith(1);
}

if (require.main === module) {
  main();
}
