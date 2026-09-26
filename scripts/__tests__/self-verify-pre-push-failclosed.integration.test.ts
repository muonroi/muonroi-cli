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

  it("every pushed ref's diff is undiffable AND no fallback base resolves either — self-verify still runs, checking everything (no --since), never skips", () => {
    const bare = join(tmpRoot, "remote.git");
    git(tmpRoot, ["init", "--quiet", "--bare", bare]);

    const seed = join(tmpRoot, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--quiet"]);
    commit(seed, "base.txt", "v1\n", "base");
    git(seed, ["remote", "add", "origin", bare]);
    // Same as above: only main, so the develop/HEAD/master fallback is a
    // dead end too — this is what forces base:null instead of a fallback base.
    git(seed, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

    const work = join(tmpRoot, "work");
    git(tmpRoot, ["clone", "--quiet", "--no-local", "--branch", "main", "--single-branch", bare, work]);

    git(work, ["checkout", "-b", "local-branch"]);
    const localSha = commit(work, "README.md", "docs only, irrelevant to the outcome\n", "docs");

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
    // The precise proof this is fixed: self-verify actually ran WITHOUT
    // --since (there is no trustworthy comparison point left at all), not
    // that it merely logged something and then quietly skipped.
    expect(result.stdout).toContain("STUB_ARGS:run src/index.ts self-verify --max 4 --no-emit");
  }, 15000);
});
