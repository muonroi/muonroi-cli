// Gap (a): planning-state relocation. `planningRoot` used to pick `.planning/`
// at the repo root unconditionally whenever it existed — a problem for a repo
// that already uses `.planning/` for its own, unrelated plan folders (e.g. a
// Shipd/Olympus challenge repo). `resolveStateDirOverride` (env
// `MUONROI_STATE_DIR` / project setting `stateDir`) lets a session relocate
// GSD state elsewhere without touching default behavior.
//
// Round-2 fix (HIGH): a repo-committed `stateDir` used to be honoured
// unconditionally — a malicious or buggy project setting could point the CLI
// at `/etc`, or escape the repo via `../../x`. Every temp dir here is a real
// git repo (`git init`) so `resolveStateDirOverride`'s confinement check
// (project setting must resolve inside the project's git root) has a root to
// confine against; the confinement-specific tests are their own `describe`
// block below.
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planningRoot, resolveStateDirOverride } from "../paths.js";

describe("gsd/paths — state dir relocation (gap a)", () => {
  let cwd: string;
  let prevCwd: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-paths-"));
    execFileSync("git", ["init", "-q"], { cwd });
    prevCwd = process.cwd();
    prevEnv = process.env.MUONROI_STATE_DIR;
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.MUONROI_STATE_DIR;
    else process.env.MUONROI_STATE_DIR = prevEnv;
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("default behavior is unchanged when no override is configured", () => {
    process.chdir(cwd);
    expect(resolveStateDirOverride(cwd)).toBeUndefined();
    // No .planning/ and no folded dir exist yet → falls through to the
    // folded location (existing default), never a stray override.
    expect(planningRoot(cwd)).toBe(path.join(cwd, ".muonroi-flow", "planning"));
  });

  it("MUONROI_STATE_DIR (absolute) wins over an existing .planning/", async () => {
    await fs.mkdir(path.join(cwd, ".planning"), { recursive: true });
    const stateDir = path.join(cwd, "my-state");
    process.env.MUONROI_STATE_DIR = stateDir;
    process.chdir(cwd);
    expect(planningRoot(cwd)).toBe(stateDir);
  });

  it("MUONROI_STATE_DIR (relative) resolves against cwd", () => {
    process.env.MUONROI_STATE_DIR = "relocated-state";
    process.chdir(cwd);
    expect(planningRoot(cwd)).toBe(path.join(cwd, "relocated-state"));
  });

  it("project setting stateDir (.muonroi-cli/settings.json) relocates state when no env override is set", async () => {
    await fs.mkdir(path.join(cwd, ".planning"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".muonroi-cli", "settings.json"),
      JSON.stringify({ stateDir: "shipd-agent-state" }),
      "utf8",
    );
    process.chdir(cwd);
    expect(planningRoot(cwd)).toBe(path.join(cwd, "shipd-agent-state"));
  });

  it("env MUONROI_STATE_DIR takes priority over the project setting", async () => {
    await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".muonroi-cli", "settings.json"),
      JSON.stringify({ stateDir: "from-project-setting" }),
      "utf8",
    );
    process.env.MUONROI_STATE_DIR = "from-env";
    process.chdir(cwd);
    expect(planningRoot(cwd)).toBe(path.join(cwd, "from-env"));
  });

  it("existing .planning/ still wins when no override is configured (back-compat)", async () => {
    await fs.mkdir(path.join(cwd, ".planning"), { recursive: true });
    process.chdir(cwd);
    expect(planningRoot(cwd)).toBe(path.join(cwd, ".planning"));
  });
});

describe("gsd/paths — stateDir confinement (round-2, HIGH)", () => {
  let cwd: string;
  let prevCwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-paths-confine-"));
    execFileSync("git", ["init", "-q"], { cwd });
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("rejects an absolute project stateDir and falls back to the default", async () => {
    await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".muonroi-cli", "settings.json"),
      JSON.stringify({ stateDir: "/etc/muonroi-state" }),
      "utf8",
    );
    process.chdir(cwd);
    expect(resolveStateDirOverride(cwd)).toBeUndefined();
    expect(planningRoot(cwd)).toBe(path.join(cwd, ".muonroi-flow", "planning"));
  });

  it("rejects a project stateDir that escapes the git root via ../..", async () => {
    await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".muonroi-cli", "settings.json"),
      JSON.stringify({ stateDir: "../../../../tmp/escaped-state" }),
      "utf8",
    );
    process.chdir(cwd);
    expect(resolveStateDirOverride(cwd)).toBeUndefined();
  });

  it("rejects a project stateDir when cwd is not inside any git repo", async () => {
    const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-paths-nogit-"));
    try {
      await fs.mkdir(path.join(noGitDir, ".muonroi-cli"), { recursive: true });
      await fs.writeFile(
        path.join(noGitDir, ".muonroi-cli", "settings.json"),
        JSON.stringify({ stateDir: "some-state" }),
        "utf8",
      );
      process.chdir(noGitDir);
      expect(resolveStateDirOverride(noGitDir)).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      await fs.rm(noGitDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("accepts a project stateDir that resolves inside the git root through a symlink", async () => {
    // A symlinked subdirectory that, once realpath'd, still lands inside cwd —
    // must be accepted (this is the "resolves ... inside the project's git
    // root" half of the fix, not just a lexical prefix check).
    const realTarget = path.join(cwd, "real-state-target");
    await fs.mkdir(realTarget, { recursive: true });
    await fs.symlink(realTarget, path.join(cwd, "state-link"));
    await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".muonroi-cli", "settings.json"),
      JSON.stringify({ stateDir: "state-link" }),
      "utf8",
    );
    process.chdir(cwd);
    const resolved = resolveStateDirOverride(cwd);
    expect(resolved).toBeDefined();
    // realpath'd: resolves to the real target, not the symlink path.
    expect(resolved).toBe(await fs.realpath(realTarget));
  });

  it("rejects a project stateDir whose symlink escapes the git root even though the lexical path looks contained", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gsd-paths-outside-"));
    try {
      await fs.symlink(outside, path.join(cwd, "looks-contained"));
      await fs.mkdir(path.join(cwd, ".muonroi-cli"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, ".muonroi-cli", "settings.json"),
        JSON.stringify({ stateDir: "looks-contained" }),
        "utf8",
      );
      process.chdir(cwd);
      expect(resolveStateDirOverride(cwd)).toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("env MUONROI_STATE_DIR is allowed anywhere (user-controlled) and is created 0700", async () => {
    const prevEnv = process.env.MUONROI_STATE_DIR;
    const outside = path.join(os.tmpdir(), `gsd-paths-env-anywhere-${process.pid}`);
    process.env.MUONROI_STATE_DIR = outside;
    try {
      process.chdir(cwd);
      const resolved = resolveStateDirOverride(cwd);
      expect(resolved).toBe(outside);
      const stat = await fs.stat(outside);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    } finally {
      if (prevEnv === undefined) delete process.env.MUONROI_STATE_DIR;
      else process.env.MUONROI_STATE_DIR = prevEnv;
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
