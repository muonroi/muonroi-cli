import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "child_process";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog, MODELS } from "../models/registry.js";
import { DelegationManager } from "./delegations.js";

vi.mock("child_process", async () => ({
  ...(await vi.importActual<typeof import("child_process")>("child_process")),
  spawn: vi.fn(() => ({ pid: process.pid, unref: vi.fn(), once: vi.fn() })),
}));

beforeAll(async () => {
  await loadCatalog();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("durable explicit worker dispatch", () => {
  it("persists actual worker selection and permissions, but hands credentials only through provider-scoped process environment", async () => {
    const home = mkdtempSync(join(tmpdir(), "orchestration-dispatch-"));
    vi.stubEnv("MUONROI_CLI_HOME", home);
    vi.stubEnv("MUONROI_BACKGROUND_CHILD", "0");
    const chosen = MODELS.find((row) => row.provider && row.contextWindow > 0 && row.supportsClientTools !== false)!;
    const request = {
      agent: "general",
      description: "Owned work",
      prompt: "Seven bounded fields",
      modelId: chosen.id,
      reasoningEffort: "high" as const,
      allowedMcpTools: ["mcp_docs__read"],
    };
    try {
      const manager = new DelegationManager(
        () => home,
        () => "fixture-owner",
      );
      const fixtureCredential = ["in-memory", "fixture", "secret"].join("-");
      const result = await manager.startTask(request, {
        model: "parent-model-must-not-be-used",
        sandboxMode: "off",
        maxToolRounds: 2,
        maxTokens: 2048,
        permissionMode: "safe",
        workerApiKey: fixtureCredential,
        workerProviderId: chosen.provider,
      });
      expect(result.success).toBe(true);
      const call = vi.mocked(spawn).mock.calls[0]!;
      const args = call[1] as string[];
      const jobPath = args[args.indexOf("--background-task-file") + 1]!;
      const text = readFileSync(jobPath, "utf8");
      expect(JSON.parse(text)).toMatchObject({
        model: chosen.id,
        modelId: chosen.id,
        providerId: chosen.provider,
        executionRole: "worker",
        permissionMode: "safe",
        reasoningEffort: "high",
        allowedMcpTools: ["mcp_docs__read"],
        parentSessionId: "fixture-owner",
      });
      expect(text).not.toContain("in-memory-fixture-secret");
      expect(call[2]).toMatchObject({
        windowsHide: true,
        env: { MUONROI_BACKGROUND_PROVIDER: chosen.provider, MUONROI_BACKGROUND_API_KEY: fixtureCredential },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
