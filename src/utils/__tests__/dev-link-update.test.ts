/**
 * `/update` on a linked source checkout used to print the three commands the
 * CLI could run itself ("git pull && bun install && bun run build") and stop
 * there. These cover the behaviour that replaced it.
 */

import { describe, expect, it, vi } from "vitest";
import type { CommandOutcome, CommandStep } from "../install-manager";
import { checkUpstreamCommits, runDevLinkUpdate } from "../install-manager";

const ROOT = "/repo";

/** Runner driven by a map of "cmd args" → outcome; anything unlisted succeeds. */
function fakeRunner(table: Record<string, CommandOutcome>) {
  const seen: string[] = [];
  const run = vi.fn(async (step: CommandStep): Promise<CommandOutcome> => {
    const key = `${step.cmd} ${step.args.join(" ")}`;
    seen.push(key);
    return table[key] ?? { code: 0, output: "" };
  });
  return { run, seen };
}

describe("runDevLinkUpdate", () => {
  it("pulls, installs and rebuilds — it does not just print the commands", async () => {
    const { run, seen } = fakeRunner({ "git status --porcelain": { code: 0, output: "" } });

    const result = await runDevLinkUpdate(ROOT, run);

    expect(result.success).toBe(true);
    expect(seen).toEqual(["git status --porcelain", "git pull --ff-only", "bun install", "bun run build"]);
    expect(result.output).toContain("Restart");
  });

  it("refuses to pull over uncommitted work and changes nothing", async () => {
    const { run, seen } = fakeRunner({
      "git status --porcelain": { code: 0, output: " M src/index.ts\n?? scratch.ts" },
    });

    const result = await runDevLinkUpdate(ROOT, run);

    expect(result.success).toBe(false);
    expect(result.output).toContain("src/index.ts");
    expect(seen).toEqual(["git status --porcelain"]); // nothing ran after the check
  });

  it("stops at the failing step and reports its output", async () => {
    const { run, seen } = fakeRunner({
      "git pull --ff-only": { code: 1, output: "fatal: refusing to merge unrelated histories" },
    });

    const result = await runDevLinkUpdate(ROOT, run);

    expect(result.success).toBe(false);
    expect(result.output).toContain("unrelated histories");
    expect(seen).not.toContain("bun run build");
  });
});

describe("checkUpstreamCommits", () => {
  const branchOk = { "git rev-parse --abbrev-ref HEAD": { code: 0, output: "develop\n" } };
  const remoteOk = {
    "git ls-remote origin refs/heads/develop": {
      code: 0,
      output: "0123456789abcdef0123456789abcdef01234567\trefs/heads/develop\n",
    },
  };

  it("reports behind when the remote head is an object this checkout lacks", async () => {
    const { run } = fakeRunner({
      ...branchOk,
      ...remoteOk,
      "git cat-file -e 0123456789abcdef0123456789abcdef01234567^{commit}": { code: 1, output: "" },
    });

    await expect(checkUpstreamCommits(ROOT, run)).resolves.toEqual({ branch: "develop", behind: true });
  });

  it("reports up to date when the remote head is already present locally", async () => {
    const { run } = fakeRunner({ ...branchOk, ...remoteOk });

    await expect(checkUpstreamCommits(ROOT, run)).resolves.toEqual({ branch: "develop", behind: false });
  });

  it("returns null on a detached HEAD — there is no branch to compare", async () => {
    const { run } = fakeRunner({ "git rev-parse --abbrev-ref HEAD": { code: 0, output: "HEAD\n" } });

    await expect(checkUpstreamCommits(ROOT, run)).resolves.toBeNull();
  });

  it("returns null when the remote is unreachable instead of claiming up to date", async () => {
    const { run } = fakeRunner({
      ...branchOk,
      "git ls-remote origin refs/heads/develop": { code: 128, output: "could not read from remote" },
    });

    await expect(checkUpstreamCommits(ROOT, run)).resolves.toBeNull();
  });
});

describe("runManagedUpdate — installed package (the shipped product)", () => {
  // The CLI is distributed as an npm/bun package, so `/update` on an installed
  // copy must install the update. Printing a command to paste — or worse, the
  // dev-only "pull the source and rebuild" hint — is not an update.
  it("runs the package manager for a bun-global install", async () => {
    const ran: CommandStep[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: "2.0.0" }) }));
    const mod = await import("../install-manager");

    const result = await mod.runManagedUpdate(
      "1.0.0",
      async (step) => {
        ran.push(step);
        return { code: 0, output: "installed" };
      },
      "bun-global",
    );

    expect(ran.map((s) => `${s.cmd} ${s.args.join(" ")}`)).toContain("bun add -g muonroi-cli@latest");
    expect(result.success).toBe(true);
    expect(result.output).toContain("Restart");
    expect(result.output).not.toContain("bun run build");
  });

  it("falls back to the copyable command when the install cannot replace the running files", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: "2.0.0" }) }));
    const mod = await import("../install-manager");

    const result = await mod.runManagedUpdate(
      "1.0.0",
      async () => ({ code: 1, output: "EBUSY: resource busy" }),
      "bun-global",
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("EBUSY");
    expect(result.output).toContain("bun add -g muonroi-cli@latest");
  });
});

describe("getUpdateStepForMethod", () => {
  it("uses the npm.cmd shim on Windows — a shell-less spawn cannot run bare `npm`", async () => {
    const { getUpdateStepForMethod } = await import("../install-manager");
    expect(getUpdateStepForMethod("npm-global", "win32")?.cmd).toBe("npm.cmd");
    expect(getUpdateStepForMethod("npm-global", "linux")?.cmd).toBe("npm");
    expect(getUpdateStepForMethod("bun-global", "win32")?.cmd).toBe("bun");
    expect(getUpdateStepForMethod("compiled", "linux")).toBeNull();
  });
});
