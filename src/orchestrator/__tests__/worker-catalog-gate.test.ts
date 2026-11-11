import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import type { ProviderId } from "../../providers/types.js";
import { closeDatabase, getDatabasePath } from "../../storage/db.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));
vi.mock("../../mcp/client-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp/client-pool.js")>()),
  acquireMcpTools: vi.fn(async () => ({ tools: {}, errors: [], needsKey: [], close: async () => {} })),
}));

describe("actual root SDK catalog admission under heavy/revise", () => {
  it("returns native inventories but refuses a general worker before launch, without altering the plan", async () => {
    const home = mkdtempSync(join(tmpdir(), "worker-catalog-gate-"));
    const originalCwd = process.cwd();
    const env = {
      NODE_ENV: "test",
      HOME: home,
      USERPROFILE: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_AUTH_DIR: join(home, "auth"),
      MUONROI_ENV_FILE: join(home, ".env"),
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_FLOW_NATIVE: "1",
      MUONROI_FLOW_HARD_GATE: "1",
    };
    const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    process.chdir(home);
    closeDatabase();
    let root: Agent | undefined;
    let handle: ReturnType<typeof installMockModel> | undefined;
    try {
      expect(getDatabasePath().startsWith(home)).toBe(true);
      await loadCatalog();
      const model = MODELS.find((row) => row.tier === "fast" && row.provider && row.supportsClientTools !== false)!;
      vi.spyOn(settings, "isModelDisabled").mockImplementation((id) => id !== model.id);
      vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
      settings.saveUserSettings({ defaultProvider: model.provider as ProviderId, peakHourPolicy: { enabled: false } });
      handle = installMockModel({
        fixture: {
          autoClassify: true,
          stream: [
            toolCallStream({ toolName: "worker_models", toolCallId: "catalog-models", input: {} }),
            toolCallStream({ toolName: "worker_capabilities", toolCallId: "catalog-capabilities", input: {} }),
            toolCallStream({
              toolName: "task",
              toolCallId: "denied-worker",
              input: {
                agent: "general",
                modelId: model.id,
                background: true,
                maxToolRounds: 6,
                description: "Bounded Unicode fixture",
                prompt: "Write, edit and read one Unicode fixture.",
              },
            }),
            textOnlyStream("Inventories available; mutation-capable dispatch remains locked."),
          ],
        },
      });
      const doStream = handle.model.doStream.bind(handle.model);
      vi.spyOn(handle.model, "doStream").mockImplementation((options) => {
        mkdirSync(join(home, ".planning"), { recursive: true });
        writeFileSync(
          join(home, ".planning", "STATE.md"),
          "| Field | Value |\n|---|---|\n| Phase | plan |\n| Depth | heavy |\n",
        );
        writeFileSync(join(home, ".planning", "PLAN-VERIFY.md"), "verdict: revise\n");
        return doStream(options);
      });
      root = new Agent("offline-fixture-key", undefined, model.id, 6, {
        persistSession: true,
        executionRole: "orchestrator",
        permissionMode: "yolo",
      });
      const launch = vi
        .spyOn(root as any, "runDelegation")
        .mockResolvedValue({ success: true, output: "MUST_NOT_START" });
      const chunks = [];
      for await (const chunk of root.processMessage("Run one bounded runtime probe without modifying workflow state"))
        chunks.push(chunk);
      expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);
      const outbound = JSON.stringify(handle.model.doStreamCalls);
      expect(outbound).toContain('"models"');
      expect(outbound).toContain(model.id);
      expect(outbound).toContain('"capabilities"');
      expect(outbound).toContain("mutation-capable worker");
      expect(launch).not.toHaveBeenCalled();
      expect(readFileSync(join(home, ".planning", "PLAN-VERIFY.md"), "utf8")).toBe("verdict: revise\n");
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    } finally {
      await root?.cleanup();
      handle?.uninstall();
      closeDatabase();
      process.chdir(originalCwd);
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);
});
