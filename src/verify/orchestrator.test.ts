import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./checkpoint", () => ({
  ensureVerifyCheckpoint: vi.fn(async () => ({ created: false })),
}));

// Sandbox mode gates the shuru checkpoint. Default to "shuru" so the existing
// checkpoint-wiring coverage still exercises that path; the off-mode test flips it.
vi.mock("../utils/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/settings")>();
  return { ...actual, getCurrentSandboxMode: vi.fn(() => "shuru") };
});

import { getCurrentSandboxMode } from "../utils/settings";
import { ensureVerifyCheckpoint } from "./checkpoint";
import { prepareVerifyRun, runVerifyOrchestration } from "./orchestrator";

const ensureVerifyCheckpointMock = vi.mocked(ensureVerifyCheckpoint);
const sandboxModeMock = vi.mocked(getCurrentSandboxMode);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  ensureVerifyCheckpointMock.mockReset();
  ensureVerifyCheckpointMock.mockResolvedValue({ created: false });
  sandboxModeMock.mockReset();
  sandboxModeMock.mockReturnValue("shuru");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("verify orchestrator", () => {
  it("uses the environment manifest as the highest-priority recipe source", async () => {
    const dir = makeTempDir("muonroi-verify-orch-manifest-");
    fs.writeFileSync(
      path.join(dir, "environment.json"),
      JSON.stringify(
        {
          ecosystem: "custom",
          appKind: "node",
          appLabel: "Manifest app",
          install: ["npm ci"],
          build: ["npm run build"],
          smokeKind: "none",
        },
        null,
        2,
      ),
    );

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.profile.recipe.ecosystem).toBe("custom");
    expect(prepared.profile.recipe.installCommands).toEqual(["npm ci"]);
    expect(prepared.usedVerifyDetect).toBe(false);
    expect(agent.detectVerifyRecipe).not.toHaveBeenCalled();
  });

  // THE USER'S FILE. `.muonroi-cli/environment.json` carries no provenance — no
  // version, no generator stamp, no checksum (see `VerifyEnvironmentManifest`,
  // src/types/index.ts:150) — so a record this loop wrote and one a human hand-
  // authored are byte-indistinguishable. The refresh policy therefore refreshes
  // the derivation IN MEMORY on every run and never rewrites the file, which means
  // the undecidable question never has to be answered. This test fails the moment
  // someone makes the loop write over an existing manifest.
  it("re-derives from disk WITHOUT rewriting the stored manifest or re-running verify-detect", async () => {
    const dir = makeTempDir("muonroi-verify-orch-no-overwrite-");
    // The qa-platform shape: root `verify` script, Next.js front end one directory
    // down, pytest back end one directory down.
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "qa-platform", private: true, scripts: { verify: "npx tsc --noEmit" } }),
    );
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "frontend", "package.json"),
      JSON.stringify({ name: "frontend", scripts: { build: "next build" }, dependencies: { next: "16.3.4" } }),
    );
    fs.writeFileSync(path.join(dir, "frontend", "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend", "conftest.py"), "import sys\n");
    fs.writeFileSync(path.join(dir, "backend", "requirements.txt"), "fastapi==0.115.0\n");

    // A byte-for-byte copy of the real stored record from
    // D:\sources\CompanyLibs\qa-platform (READ-ONLY; nothing here touches it).
    const manifestPath = path.join(dir, ".muonroi-cli", "environment.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const manifestBytes = fs.readFileSync(
      path.join(__dirname, "__tests__", "fixtures", "qa-platform-environment.json"),
    );
    fs.writeFileSync(manifestPath, manifestBytes);
    const before = fs.statSync(manifestPath);

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});

    // The cache's purpose — no second LLM verify-detect turn — is untouched.
    expect(agent.detectVerifyRecipe).not.toHaveBeenCalled();
    expect(prepared.usedVerifyDetect).toBe(false);
    // The file is byte-identical and was not even re-written with the same bytes.
    const after = fs.statSync(manifestPath);
    expect(fs.readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // And the derivation reached the profile anyway.
    expect(prepared.profile.recipe.testCommands.some((c) => /-m pytest$/.test(c))).toBe(true);
    expect(prepared.profile.recipe.buildCommands).toContain("cd frontend && npm run build");
    expect(prepared.profile.recipe.buildCommands).toContain("npm run verify");
  });

  it("creates .muonroi-cli/environment.json from verify-detect when no manifest exists", async () => {
    const dir = makeTempDir("muonroi-verify-orch-generate-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => ({
        ecosystem: "custom",
        appKind: "node",
        appLabel: "Agent recipe",
        shellInitCommands: ["export FOO=bar"],
        bootstrapCommands: ["echo bootstrap"],
        installCommands: ["npm ci"],
        buildCommands: ["npm run build"],
        testCommands: [],
        startCommand: "npm run start",
        startPort: "3000",
        smokeKind: "http" as const,
        smokeTarget: "http://127.0.0.1:3000",
        evidence: ["agent-detect"],
        notes: ["generated"],
      })),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.manifestPath).toBe(path.join(dir, ".muonroi-cli", "environment.json"));
    expect(fs.existsSync(prepared.manifestPath!)).toBe(true);
    expect(prepared.usedVerifyDetect).toBe(true);
    expect(prepared.profile.recipe.installCommands).toEqual(["npm ci"]);
    expect(prepared.profile.recipe.evidence).toContain("agent-detect");
  });

  it("does not create a manifest when verify-detect returns no recipe", async () => {
    const dir = makeTempDir("muonroi-verify-orch-no-manifest-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "ok" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(prepared.manifestPath).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".muonroi-cli", "environment.json"))).toBe(false);
    expect(prepared.usedVerifyDetect).toBe(false);
  });

  it("restores sandbox settings after running verification and wires checkpoint settings", async () => {
    const dir = makeTempDir("muonroi-verify-orch-run-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    ensureVerifyCheckpointMock.mockResolvedValue({
      created: true,
      checkpointName: "verify-next-demo",
      guestWorkdir: "/grok/verify/worktree",
    });

    const originalSettings = { allowNet: false, from: "base" };
    const agent = {
      getCwd: () => dir,
      getSandboxSettings: vi.fn(() => originalSettings),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "verified" })),
    };

    const result = await runVerifyOrchestration(agent, {});
    expect(result.success).toBe(true);
    expect(agent.setSandboxSettings).toHaveBeenCalledTimes(2);
    expect(agent.setSandboxSettings.mock.calls[0]?.[0]).toMatchObject({
      from: "verify-next-demo",
      guestWorkdir: "/grok/verify/worktree",
      syncHostWorkspace: true,
      allowNet: true,
    });
    expect(agent.setSandboxSettings.mock.calls[1]?.[0]).toBe(originalSettings);
  });

  it("skips the shuru checkpoint entirely when sandbox mode is off (runs on host)", async () => {
    sandboxModeMock.mockReturnValue("off");
    const dir = makeTempDir("muonroi-verify-orch-off-");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, "package-lock.json"), "");

    // If this were called on a host without shuru it would throw — the gate must
    // prevent the call, not merely swallow the error.
    ensureVerifyCheckpointMock.mockRejectedValue(new Error('Executable not found in $PATH: "shuru"'));

    const agent = {
      getCwd: () => dir,
      getSandboxSettings: () => ({}),
      setSandboxSettings: vi.fn(),
      detectVerifyRecipe: vi.fn(async () => null),
      runTaskRequest: vi.fn(async () => ({ success: true, output: "verified" })),
    };

    const prepared = await prepareVerifyRun(agent, {});
    expect(ensureVerifyCheckpointMock).not.toHaveBeenCalled();
    expect(prepared.checkpoint).toEqual({ created: false });
    expect(prepared.sandboxSettings.from).toBeUndefined();
  });
});
