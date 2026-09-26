/**
 * Round 9 — the refuter found that round 8's "could not diff → skip" was
 * itself a fail-open hole: a remote sha that exists on the remote but is
 * not yet fetched locally (the ORDINARY case — a stale remote-tracking
 * ref, a shallow clone, a first push of that branch) made
 * `git diff <remoteSha>...<localSha>` throw. The catch swallowed it,
 * contributed nothing, and a push that touched a watched dir landed with
 * self-verify silently skipped.
 *
 * These are real-git integration tests (temp repos + a bare remote), not
 * pure-function tests, because the bug is in the interaction between
 * `git cat-file -e`, a real `git fetch`, and a real `git diff` — exactly
 * the surface `self-verify-pre-push-baseref.test.ts`'s injected fakes
 * cannot exercise. The actual `bun run src/index.ts self-verify` call is
 * stubbed out (a fake `bun` placed first on PATH) so these tests run in
 * milliseconds and assert only whether self-verify WOULD have been
 * invoked, not what it would have found.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The REAL scenario planner — round 12 asserts against it directly (not a
// stub) to prove self-verify's own planning, not just that some `bun`
// process was invoked, actually sees a non-tip watched change.
import { collectChangedFiles, planScenarios } from "../../src/self-qa/scenario-planner.js";

const SCRIPT_PATH = join(__dirname, "..", "self-verify-pre-push.cjs");

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "svpp-it-"));
});

afterEach(() => {
  // Best-effort cleanup; leaving a stray temp dir on failure is not worth
  // hiding the actual assertion failure behind an rm error.
  try {
    spawnSync("rm", ["-rf", tmpRoot]);
  } catch {
    // ignore
  }
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed:\n${r.stdout}\n${r.stderr}`);
  }
  return (r.stdout || "").trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
  const full = join(cwd, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A fake `bun` on PATH so `bun run src/index.ts self-verify ...` never actually runs — it just proves whether it WAS invoked. */
function makeStubBun(exitCode: number): string {
  const binDir = mkdtempSync(join(tmpdir(), "svpp-bin-"));
  const bunPath = join(binDir, "bun");
  writeFileSync(bunPath, `#!/bin/sh\necho STUB_SELF_VERIFY_INVOKED\nexit ${exitCode}\n`);
  chmodSync(bunPath, 0o755);
  return binDir;
}

function runScript(cwd: string, stdin: string, stubBinDir: string, extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.SELF_VERIFY_PRE_PUSH;
  delete env.PRE_PUSH_REMOTE;
  env.PATH = `${stubBinDir}:${env.PATH || ""}`;
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, input: stdin, encoding: "utf8", env });
}

/**
 * A bin dir containing BOTH a stub `bun` (proves self-verify invocation
 * without running it) AND a `git` wrapper that sleeps forever on `fetch`
 * (any other subcommand passes through to the real git binary unmodified).
 * Used to prove round 10's fetch timeout: without it, a hanging `git
 * fetch` would hang the whole pre-push hook (and therefore `git push`)
 * indefinitely.
 */
function makeHangingFetchShim(bunExitCode: number, fetchSleepMs: number): string {
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const binDir = mkdtempSync(join(tmpdir(), "svpp-shim-"));

  const bunPath = join(binDir, "bun");
  writeFileSync(bunPath, `#!/bin/sh\necho STUB_SELF_VERIFY_INVOKED\nexit ${bunExitCode}\n`);
  chmodSync(bunPath, 0o755);

  const gitPath = join(binDir, "git");
  const fetchSleepSec = (fetchSleepMs / 1000).toFixed(2);
  writeFileSync(
    gitPath,
    `#!/bin/sh\nif [ "$1" = "fetch" ]; then\n  sleep ${fetchSleepSec}\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(gitPath, 0o755);

  return binDir;
}

describe("self-verify-pre-push.cjs — round 9 fail-closed integration", () => {
  it("a remote sha that exists on the remote but is unfetched locally is fetched once, diffed, and self-verify runs when it touches a watched dir", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    git(seed, ["checkout", "-b", "feature"]);
    const remoteSha = commit(seed, "src/ui/foo.ts", "export const foo = 1;\n", "add foo (feature, remote-only)");
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/feature"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);

    // Sanity: work must NOT already have the feature commit — that is the
    // whole point of this test (an unfetched remote sha).
    const preCheck = spawnSync("git", ["cat-file", "-e", `${remoteSha}^{commit}`], { cwd: work });
    expect(preCheck.status).not.toBe(0);

    git(work, ["checkout", "-b", "feature-local"]);
    const localSha = commit(work, "src/ui/bar.ts", "export const bar = 1;\n", "add bar (local, unpushed)");

    const stubBin = makeStubBun(0);
    const stdin = `refs/heads/feature-local ${localSha} refs/heads/feature ${remoteSha}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toContain("watched surface changed");
    expect(result.stderr).toContain("self-verify PASSED");
  }, 15000);

  it("a remote sha that is genuinely unresolvable (even after the fetch retry) fails CLOSED using the develop merge-base, instead of skipping", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    const developSha = commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/develop"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);
    // A single-branch clone of "main" does not create an origin/develop
    // remote-tracking ref; fetch it explicitly so the develop fallback
    // candidate can resolve, exactly as it would on a normal (non
    // single-branch) clone.
    git(work, ["fetch", "--quiet", "origin", "+refs/heads/develop:refs/remotes/origin/develop"]);

    git(work, ["checkout", "-b", "local-branch"]);
    const localSha = commit(work, "README.md", "no watched-dir change here\n", "docs only");

    const bogusRemoteSha = "f".repeat(40); // syntactically valid, present nowhere — fetch-of-a-real-ref cannot recover it
    const stubBin = makeStubBun(0);
    const stdin = `refs/heads/local-branch ${localSha} refs/heads/feature ${bogusRemoteSha}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    // The undiffable bogus sha is named in the diagnostic (why we could not
    // trust a clean diff), but the run itself must proceed via fail-closed,
    // never silently read as "no changes".
    expect(result.stderr).toContain(bogusRemoteSha);
    expect(result.stderr).toMatch(/fail(ing)? closed/i);
    expect(result.stderr).not.toContain("no UI/harness/self-qa changes detected");
    void developSha;
  }, 15000);

  it("regression guard: a real, diffable remote sha that touches nothing does NOT invoke self-verify (no new false positive)", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    git(seed, ["checkout", "-b", "feature"]);
    const remoteSha = commit(seed, "README.md", "remote-only docs change\n", "docs (feature, remote-only)");
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/feature"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);
    git(work, ["checkout", "-b", "feature-local"]);
    const localSha = commit(work, "README2.md", "local-only docs change\n", "more docs (local, unpushed)");

    const stubBin = makeStubBun(0);
    const stdin = `refs/heads/feature-local ${localSha} refs/heads/feature ${remoteSha}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toContain("no UI/harness/self-qa changes detected");
  }, 15000);

  it("empty stdin (manual invocation) falls back to diffing HEAD against the develop fallback base, instead of skipping unconditionally", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/develop"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);
    git(work, ["fetch", "--quiet", "origin", "+refs/heads/develop:refs/remotes/origin/develop"]);
    // A watched-dir change sitting only in the local checkout, never pushed.
    commit(work, "src/ui/local-only.ts", "export const x = 1;\n", "local watched change, no stdin will describe it");

    const stubBin = makeStubBun(0);
    const result = runScript(work, "", stubBin); // no pre-push stdin at all

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toContain("manual invocation");
    expect(result.stderr).toContain("watched surface changed");
  }, 15000);
});

describe("self-verify-pre-push.cjs — round 10: a hanging git fetch cannot hang the push", () => {
  it("a git fetch that sleeps far longer than the configured timeout is killed, and the hook still returns quickly and fails closed", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/develop"]);

    const work = join(tmpRoot, "work");
    // Fetched with the REAL git (setup only) before the hanging shim is on PATH.
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);
    git(work, ["fetch", "--quiet", "origin", "+refs/heads/develop:refs/remotes/origin/develop"]);

    git(work, ["checkout", "-b", "local-branch"]);
    const localSha = commit(work, "README.md", "no watched-dir change here\n", "docs only");
    // Any remote sha not already present locally forces the ensureDiffable
    // retry path — this one is real-looking but irrelevant; what matters
    // is that the shim's `git fetch` never returns in time on its own.
    const remoteSha = "a".repeat(40);

    const timeoutMs = 1000;
    const fetchSleepMs = 5000; // >> timeoutMs — proves the kill, not a lucky race
    const shimBin = makeHangingFetchShim(0, fetchSleepMs);
    const stdin = `refs/heads/local-branch ${localSha} refs/heads/feature ${remoteSha}\n`;

    const startedAt = Date.now();
    const result = runScript(work, stdin, shimBin, { SELF_VERIFY_PRE_PUSH_FETCH_TIMEOUT_MS: String(timeoutMs) });
    const elapsedMs = Date.now() - startedAt;

    // Generous margin over the configured timeout for process-spawn/kill
    // overhead, but nowhere near the shim's 5s sleep — this is the
    // measurement that proves the timeout actually bounds the hang.
    expect(elapsedMs).toBeLessThan(4000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toContain("fetching refs/heads/feature from origin to diff against it (timeout 1s)");
    expect(result.stderr).toMatch(/fail(ing)? closed/i);
  }, 10000);
});

/** Same as makeStubBun, but also echoes the exact args it received (as `STUB_ARGS:<args>`), so a test can assert whether `--since` was passed. */
function makeStubBunEchoingArgs(exitCode: number): string {
  const binDir = mkdtempSync(join(tmpdir(), "svpp-bin-"));
  const bunPath = join(binDir, "bun");
  writeFileSync(bunPath, `#!/bin/sh\necho STUB_SELF_VERIFY_INVOKED\necho STUB_ARGS:"$@"\nexit ${exitCode}\n`);
  chmodSync(bunPath, 0o755);
  return binDir;
}

describe("self-verify-pre-push.cjs — round 11: the empty-tree fallback was dead, and undiffable+no-fallback used to skip", () => {
  it("a brand-new branch with no develop/HEAD/master fetched anywhere still runs self-verify via the (now working) empty-tree diff, because it contains a watched file", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    // ONLY main is ever pushed — no develop, no master — so none of
    // origin/develop, origin/HEAD, origin/master can ever resolve locally.
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);

    // Sanity: confirm none of the fallback candidates exist locally —
    // otherwise this test would pass for the wrong reason.
    for (const ref of ["origin/develop", "origin/HEAD", "origin/master"]) {
      const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: work });
      expect(check.status).not.toBe(0);
    }

    git(work, ["checkout", "-b", "feature-local"]);
    const localSha = commit(work, "src/ui/brand-new.ts", "export const x = 1;\n", "brand-new branch, watched file");

    const stubBin = makeStubBun(0);
    // A brand-new remote branch: remote sha is all-zero.
    const stdin = `refs/heads/feature-local ${localSha} refs/heads/feature-local ${"0".repeat(40)}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toContain("diffing against the empty tree instead of skipping blind");
    expect(result.stderr).toContain("watched surface changed");
  }, 15000);

  it("every pushed ref's diff is undiffable AND no fallback base resolves either — self-verify still runs, failing closed with a REAL --since (round 12: never omitted)", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    // Same as above: only main, so the develop/HEAD/master fallback is a
    // dead end too — this is what forces the checkEverythingBase tier.
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);

    git(work, ["checkout", "-b", "local-branch"]);
    const localSha = commit(work, "README.md", "docs only, irrelevant to the outcome\n", "docs");
    const emptyTreeSha = git(work, ["hash-object", "-t", "tree", "/dev/null"]);

    // A remote sha that is genuinely unresolvable (garbage, present nowhere,
    // and the ref it claims to belong to does not exist on the remote
    // either, so the fetch retry cannot recover it) — this ref's diff is
    // undiffable, and there is no fallback base to fail closed against.
    const bogusRemoteSha = "f".repeat(40);
    const stubBin = makeStubBunEchoingArgs(0);
    const stdin = `refs/heads/local-branch ${localSha} refs/heads/feature ${bogusRemoteSha}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    expect(result.stderr).toMatch(/fail(ing)? closed/i);
    expect(result.stderr).not.toContain("no UI/harness/self-qa changes detected");
    // Round 11 would have omitted --since here (base:null) — but self-verify's
    // own CLI defaults an omitted --since to HEAD~1, not "everything", which
    // was the round-12 bug. The precise proof this is fixed: self-verify ran
    // WITH a real --since (the empty tree — a genuine "diff since the start"
    // value), never with --since omitted.
    expect(result.stdout).toContain(`STUB_ARGS:run src/index.ts self-verify --since ${emptyTreeSha} --max 4 --no-emit`);
  }, 15000);
});

describe("self-verify-pre-push.cjs — round 12: self-verify's own planner must actually see a non-tip watched change", () => {
  /**
   * Builds a repo where the ui change that matters is NOT the tip commit:
   *   commit1 (root): base.txt
   *   commit2:         src/ui/Foo.tsx — a real, plannable Semantic surface
   *                    ("model-picker"/"button" is a registered SURFACE_OPENERS
   *                    key, so scenario-planner.ts builds an actual driven
   *                    scenario for it, not just a smoke-boot fallback)
   *   commit3 (tip):   README.md — docs only
   * self-verify's own `--since` default (HEAD~1) would diff ONLY commit3
   * against commit2, seeing nothing but the docs change — round 11's
   * "omit --since" fallback is exactly as blind, since HEAD~1 is what
   * self-verify's CLI defaults an omitted --since to.
   */
  function buildNonTipUiChangeRepo(root: string): { work: string; tipSha: string } {
    const bare = join(root, "remote.git");
    git(root, ["init", "--quiet", "--bare", bare]);

    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "root commit");
    git(seed, ["remote", "add", "origin", bare]);
    // Only main is ever pushed — no develop/HEAD/master fallback exists,
    // forcing both the empty-tree (no-candidate) and checkEverythingBase
    // (undiffable, no-fallback) tiers to do the real work in these tests.
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const work = join(root, "work");
    git(root, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);

    git(work, ["checkout", "-b", "feature-local"]);
    commit(
      work,
      "src/ui/Foo.tsx",
      '<Semantic id="model-picker" role="button">\n  <button>Open model picker</button>\n</Semantic>\n',
      "non-tip: add a real plannable UI surface",
    );
    const tipSha = commit(work, "README.md", "docs only, sits on top of the ui commit\n", "tip: docs only");
    return { work, tipSha };
  }

  it("double-failure path (undiffable ref, no fallback): the resolved --since actually surfaces the non-tip UI file to the real planner", () => {
    const { work, tipSha } = buildNonTipUiChangeRepo(tmpRoot);

    const bogusRemoteSha = "f".repeat(40);
    const stubBin = makeStubBunEchoingArgs(0);
    const stdin = `refs/heads/feature-local ${tipSha} refs/heads/feature ${bogusRemoteSha}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    const argsLine = result.stdout.split("\n").find((l) => l.startsWith("STUB_ARGS:"));
    expect(argsLine).toBeDefined();
    const sinceMatch = argsLine?.match(/--since (\S+)/);
    expect(sinceMatch).not.toBeNull();
    const sinceValue = sinceMatch?.[1] ?? "";

    // Prove it with the REAL planner, not a stub: this is exactly what
    // `bun run src/index.ts self-verify --since <sinceValue>` would compute.
    const changedFiles = collectChangedFiles({ cwd: work, baseRef: sinceValue });
    expect(changedFiles).toContain("src/ui/Foo.tsx");

    const scenarios = planScenarios({ cwd: work, baseRef: sinceValue, maxScenarios: 8 });
    expect(scenarios.some((s) => s.id === "button-model-picker")).toBe(true);
  }, 15000);

  it("empty-tree (no-candidate-base) path: the resolved --since also surfaces the non-tip UI file to the real planner", () => {
    const { work, tipSha } = buildNonTipUiChangeRepo(tmpRoot);

    const stubBin = makeStubBunEchoingArgs(0);
    // A brand-new remote branch: remote sha is all-zero, and (per
    // buildNonTipUiChangeRepo) no develop/HEAD/master exists either — this
    // is the "no candidate base at all" empty-tree path from round 10/11.
    const stdin = `refs/heads/feature-local ${tipSha} refs/heads/feature-local ${"0".repeat(40)}\n`;
    const result = runScript(work, stdin, stubBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STUB_SELF_VERIFY_INVOKED");
    const argsLine = result.stdout.split("\n").find((l) => l.startsWith("STUB_ARGS:"));
    expect(argsLine).toBeDefined();
    const sinceMatch = argsLine?.match(/--since (\S+)/);
    expect(sinceMatch).not.toBeNull();
    const sinceValue = sinceMatch?.[1] ?? "";

    const changedFiles = collectChangedFiles({ cwd: work, baseRef: sinceValue });
    expect(changedFiles).toContain("src/ui/Foo.tsx");

    const scenarios = planScenarios({ cwd: work, baseRef: sinceValue, maxScenarios: 8 });
    expect(scenarios.some((s) => s.id === "button-model-picker")).toBe(true);
  }, 15000);
});
