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
    // delegations.ts resolves its root as `MUONROI_CLI_HOME ?? homedir()/.muonroi-cli`
    // and vitest-setup.ts pins that var suite-wide, so the homedir mock alone no
    // longer redirects it. Restored in afterEach.
    process.env.MUONROI_CLI_HOME = path.join(options.home, ".muonroi-cli");
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

const originalCliHome = process.env.MUONROI_CLI_HOME;

afterEach(() => {
  if (originalCliHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = originalCliHome;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("os");
  vi.doUnmock("child_process");
});

describe("DelegationManager sandbox propagation", () => {
  it("launches in the explicit target workspace while preserving owner-scoped storage", async () => {
    const home = makeTempDir("muonroi-target-home-");
    const ownerCwd = makeTempDir("muonroi-owner-cwd-");
    const targetCwd = makeTempDir("muonroi-target-cwd-");
    const spawnMock = vi.fn(() => ({ pid: 2468, unref: vi.fn(), once: vi.fn() }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(
      () => ownerCwd,
      () => "main-owner",
    );
    await manager.startTask(
      { agent: "verify", cwd: targetCwd, description: "Assigned tests", prompt: "Run tests" },
      { model: "fixture", sandboxMode: "off", maxToolRounds: 2, maxTokens: 100 },
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--directory", targetCwd]),
      expect.objectContaining({ cwd: targetCwd }),
    );
    expect(readStoredDelegationRecord(home)).toMatchObject({
      cwd: targetCwd,
      parentSessionId: "main-owner",
      sandboxMode: "off",
    });
  });

  it("launches a native editing task with a durable receipt and delivers its result to the owner", async () => {
    const home = makeTempDir("muonroi-native-task-home-");
    const cwd = makeTempDir("muonroi-native-task-cwd-");
    const spawnMock = vi.fn(() => ({ pid: 2468, unref: vi.fn(), once: vi.fn() }));
    const mod = await importDelegationsModule({ home, spawnMock });
    const manager = new mod.DelegationManager(
      () => cwd,
      () => "main-owner",
    );
    const receipt = await manager.startTask(
      {
        agent: "general",
        description: "Implement",
        prompt: "Edit the owned worktree",
        maxToolRounds: 7,
        modelId: "worker-model",
      },
      { model: "parent-model", sandboxMode: "off", maxToolRounds: 7, maxTokens: 100 },
    );
    expect(receipt.success).toBe(true);
    expect(receipt.delegation).toMatchObject({ agent: "general", status: "running" });
    const record = readStoredDelegationRecord(home) as unknown as import("./delegations").StoredDelegation;
    expect(record).toMatchObject({
      kind: "task",
      agent: "general",
      modelId: "worker-model",
      parentSessionId: "main-owner",
      maxToolRounds: 7,
    });
    await mod.completeDelegation(record.outputPath.replace(/\.md$/, ".json"), "WORKER_FINISHED");
    expect(await manager.read(record.id)).toContain("WORKER_FINISHED");
    expect(await manager.consumeNotifications()).toHaveLength(0);
    expect(await manager.consumeNotifications()).toHaveLength(0);
  });

  it("keeps ordinary research delegation read-only", async () => {
    const spawnMock = vi.fn();
    const mod = await importDelegationsModule({ spawnMock });
    const manager = new mod.DelegationManager(() => process.cwd());
    const result = await manager.start(
      { agent: "general", description: "Edit", prompt: "Edit" },
      { model: "test-model", sandboxMode: "off", maxToolRounds: 2, maxTokens: 100 },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("read-only");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses nested native background tasks", async () => {
    const previous = process.env.MUONROI_BACKGROUND_CHILD;
    process.env.MUONROI_BACKGROUND_CHILD = "1";
    try {
      const spawnMock = vi.fn();
      const mod = await importDelegationsModule({ spawnMock });
      const manager = new mod.DelegationManager(() => process.cwd());
      const result = await manager.startTask(
        { agent: "general", description: "Edit", prompt: "Edit" },
        { model: "test-model", sandboxMode: "off", maxToolRounds: 2, maxTokens: 100 },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("Nested");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MUONROI_BACKGROUND_CHILD;
      else process.env.MUONROI_BACKGROUND_CHILD = previous;
    }
  });

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
