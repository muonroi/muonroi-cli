// Gap (a): planning-state relocation. `planningRoot` used to pick `.planning/`
// at the repo root unconditionally whenever it existed — a problem for a repo
// that already uses `.planning/` for its own, unrelated plan folders (e.g. a
// Shipd/Olympus challenge repo). `resolveStateDirOverride` (env
// `MUONROI_STATE_DIR` / project setting `stateDir`) lets a session relocate
// GSD state elsewhere without touching default behavior.
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
