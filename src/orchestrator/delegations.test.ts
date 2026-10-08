import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readStoredDelegationRecord(home: string): Record<string, unknown> {
  const delegationsRoot = path.join(home, ".muonroi-cli", "delegations");
  const projectDirs = fs.readdirSync(delegationsRoot);
  expect(projectDirs).toHaveLength(1);
  const projectDir = path.join(delegationsRoot, projectDirs[0] as string);
  const files = fs.readdirSync(projectDir).filter((file) => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(projectDir, files[0] as string), "utf8")) as Record<string, unknown>;
}

async function importDelegationsModule(options: { home?: string; spawnMock?: ReturnType<typeof vi.fn> } = {}) {
  vi.resetModules();
  vi.doUnmock("os");
  vi.doUnmock("child_process");

  if (options.home) {
    const osActual = await vi.importActual<typeof import("os")>("os");
    vi.doMock("os", () => ({
      ...osActual,
      default: { ...osActual, homedir: () => options.home! },
      homedir: () => options.home!,
    }));
  }

  if (options.spawnMock) {
    const cpActual = await vi.importActual<typeof import("child_process")>("child_process");
    vi.doMock("child_process", () => ({
      ...cpActual,
      spawn: options.spawnMock,
    }));
  }

  return import("./delegations");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("os");
  vi.doUnmock("child_process");
});

describe("DelegationManager sandbox propagation", () => {
  it("stores a helper's job under main's project even when helper execution cwd differs", async () => {
    const home = makeTempDir("muonroi-delegation-home-");
    const mainCwd = makeTempDir("muonroi-delegation-main-");
    const childCwd = makeTempDir("muonroi-delegation-child-");
    const spawnMock = vi.fn(() => ({ pid: 2468, unref: vi.fn(), once: vi.fn() }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const helper = new mod.DelegationManager(
      () => childCwd,
      () => "main-owner",
      () => mainCwd,
    );
    const main = new mod.DelegationManager(
      () => mainCwd,
      () => "main-owner",
    );
    await helper.start(
      { agent: "explore", description: "Inspect", prompt: "Inspect" },
      { model: "test-model", sandboxMode: "off", maxToolRounds: 2, maxTokens: 100 },
    );
    const record = readStoredDelegationRecord(home) as any;
    const jobPath = record.outputPath.replace(/\.md$/, ".json");
    await mod.completeDelegation(jobPath, "Helper output");
    expect(await main.consumeNotifications()).toHaveLength(1);
    expect(record.cwd).toBe(childCwd);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.anything(),
      expect.objectContaining({ cwd: childCwd }),
    );
  });

  it("persists sandbox mode in background delegation records", async () => {
    const home = makeTempDir("muonroi-delegation-home-");
    const cwd = makeTempDir("muonroi-delegation-cwd-");
    const spawnMock = vi.fn(() => ({
      pid: 2468,
      unref: vi.fn(),
      once: vi.fn(),
    }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "main-owner",
    );

    const result = await manager.start(
      {
        agent: "explore",
        description: "Inspect the repo",
        prompt: "Find the execution path.",
      },
      {
        model: "muonroi-test-model",
        sandboxMode: "shuru",
        maxToolRounds: 25,
        maxTokens: 2048,
      },
    );

    expect(result.success).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--directory", cwd]),
      expect.objectContaining({ cwd }),
    );

    const record = readStoredDelegationRecord(home) as {
      sandboxMode: string;
      pid: number;
    };

    expect(record.sandboxMode).toBe("shuru");
    expect(record.pid).toBe(2468);
    expect((record as any).parentSessionId).toBe("main-owner");
  });

  it("persists sandbox settings in background delegation records", async () => {
    const home = makeTempDir("muonroi-delegation-home-");
    const cwd = makeTempDir("muonroi-delegation-cwd-");
    const spawnMock = vi.fn(() => ({
      pid: 3579,
      unref: vi.fn(),
      once: vi.fn(),
    }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(() => cwd);

    const sandboxSettings = {
      allowNet: true,
      allowedHosts: ["api.openai.com"],
      cpus: 4,
      memory: 4096,
    };

    await manager.start(
      {
        agent: "explore",
        description: "Inspect",
        prompt: "Look around",
      },
      {
        model: "muonroi-test-model",
        sandboxMode: "shuru",
        sandboxSettings,
        maxToolRounds: 25,
        maxTokens: 2048,
      },
    );

    const record = readStoredDelegationRecord(home) as {
      sandboxMode: string;
      sandboxSettings?: {
        allowNet: boolean;
        allowedHosts: string[];
        cpus: number;
        memory: number;
      };
    };

    expect(record.sandboxMode).toBe("shuru");
    expect(record.sandboxSettings).toEqual(sandboxSettings);
  });
});
