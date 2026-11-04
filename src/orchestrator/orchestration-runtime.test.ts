import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema } from "ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../__test-helpers__/catalog-fixtures.js";
import { loadCatalog, MODELS } from "../models/registry.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import * as keychain from "../providers/keychain.js";
import { buildTurnProviderOptions, resolveModelRuntime } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "../tools/registry.js";
import * as settings from "../utils/settings.js";
import { selectOrchestratorModel, validateWorkerSelection } from "./orchestration-policy.js";
import { Agent } from "./orchestrator.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});
afterEach(() => vi.restoreAllMocks());

describe("orchestrator runtime integration", () => {
  it("explicit ideal forceCouncil deterministically launches durable advice while main only coordinates", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const start = vi.spyOn(root, "startCouncil").mockResolvedValue({ success: true, output: "jobId=forced-council" });
    const process = vi.spyOn(root, "processMessage").mockImplementation(async function* () {
      yield { type: "content", content: "Main coordinates bounded workers" };
    });
    try {
      const chunks = [];
      for await (const chunk of root.runProductLoopV1({
        subcommand: "start",
        idea: "Explicit user goal",
        flags: { forceCouncil: true, doneThreshold: 90 },
      }))
        chunks.push(chunk);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ topic: "Explicit user goal" }));
      expect(process.mock.calls[0]![0]).toContain("jobId=forced-council");
      expect(chunks[0]!.content).toContain("jobId=forced-council");
      expect(root.getExecutionRole()).toBe("orchestrator");
    } finally {
      await root.cleanup();
    }
  });

  it("refuses background council before spawn when the shared worker/council capacity is full", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const internal = root as any;
    vi.spyOn(internal, "parallelDelegationRefusal").mockResolvedValue("Background worker/council capacity is full");
    const spawn = vi
      .spyOn(internal.delegations, "startCouncil")
      .mockResolvedValue({ success: true, output: "Unexpected launch" });
    try {
      const result = await root.startCouncil({
        topic: "Topic",
        reason: "Reason",
        context: "",
        outputContract: "Advice",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("capacity is full");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await root.cleanup();
    }
  });

  it("root slash council yields a background receipt without entering the debate", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const start = vi.spyOn(root, "startCouncil").mockResolvedValue({ success: true, output: "jobId=durable-council" });
    try {
      const chunks = [];
      for await (const chunk of root.runCouncilV2("Explicit topic")) chunks.push(chunk);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ topic: "Explicit topic", context: "" }));
      expect(chunks.map((c) => c.type)).toEqual(["content", "done"]);
      expect(chunks[0]!.content).toContain("jobId=durable-council");
    } finally {
      await root.cleanup();
    }
  });
  it("headless root foreground task uses a durable launch and host wait, while background stays immediate", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const internal = root as any;
    const dispatch = vi
      .spyOn(internal, "runDelegation")
      .mockResolvedValue({ success: true, output: "Started", delegation: { id: "durable-worker" } });
    const wait = vi
      .spyOn(internal.delegations, "waitResult")
      .mockResolvedValue({ success: true, output: "jobId=durable-worker\nresultVersion=current\nverified output" });
    try {
      const request = { agent: "general", modelId: low.id, description: "Scope", prompt: "Brief" };
      expect((await internal.runTask(request)).output).toContain("resultVersion=current");
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(request), undefined, true);
      expect(wait).toHaveBeenCalledWith("durable-worker", undefined);
      wait.mockClear();
      expect((await internal.runTask({ ...request, background: true })).output).toBe("Started");
      expect(wait).not.toHaveBeenCalled();
    } finally {
      await root.cleanup();
    }
  });

  it("defaults root to provider flagship on constructor, model/mode/provider change while workers keep exact selection", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const low = MODELS.find((row) => row.provider && row.tier === "fast" && row.supportsClientTools !== false)!;
    const root = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false });
    const worker = new Agent("fixture-key", undefined, low.id, 1, { persistSession: false, executionRole: "worker" });
    try {
      const expected = selectOrchestratorModel(low.provider!).id;
      expect(root.getModel()).toBe(expected);
      expect(root.getExecutionRole()).toBe("orchestrator");
      expect(worker.getModel()).toBe(low.id);
      expect(() => root.setModel("gpt-unknown-fixture-prefix")).toThrow("Unknown orchestrator model");
      expect(root.getModel()).toBe(expected);
      root.setModel(low.id);
      root.setMode("ask");
      expect(root.getModel()).toBe(expected);
      const other = MODELS.find(
        (row) => row.provider !== low.provider && row.provider && row.supportsClientTools !== false,
      )!;
      root.setProviderAndKey(other.provider as ProviderId, "other-fixture-key");
      expect(root.getModel()).toBe(selectOrchestratorModel(other.provider!).id);
      expect(root.getProviderId()).toBe(other.provider);
    } finally {
      await root.cleanup();
      await worker.cleanup();
    }
  });

  it("main defaults high, saved effort wins, and explicit worker effort survives per-turn composition", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    const saved = vi.spyOn(settings, "getReasoningEffortForModel").mockReturnValue(undefined);
    const selected = MODELS.find(
      (row) =>
        row.reasoning && row.supportsReasoningEffort !== false && row.provider && row.supportsClientTools !== false,
    )!;
    const root = new Agent("fixture-key", undefined, selected.id, 1, { persistSession: false });
    try {
      expect(root.getReasoningEffort()).toBe("high");
      saved.mockReturnValue("low");
      expect(root.getReasoningEffort()).toBe("low");
      const runtime = resolveModelRuntime(selected.id, { reasoningEffort: "high", stage: "subagent" });
      expect(runtime.reasoningEffort).toBe("high");
      const expected = getProviderCapabilities(selected.provider as ProviderId).buildProviderOptions({
        model: selected,
        reasoningEffort: "high",
        sessionId: "fixture",
      });
      expect(buildTurnProviderOptions(runtime, { sessionId: "fixture" })).toMatchObject(expected ?? {});
    } finally {
      await root.cleanup();
    }
  });

  it("validates explicit worker choice and credentials without substituting defaults", async () => {
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(false);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    vi.spyOn(keychain, "getConfiguredProviders").mockResolvedValue([]);
    const chosen = MODELS.find((row) => row.provider && row.supportsClientTools !== false && row.contextWindow > 0)!;
    const request = { agent: "general", description: "Bounded work", prompt: "Inspect assigned scope" };
    await expect(validateWorkerSelection(request)).rejects.toThrow("worker_model_required");
    await expect(validateWorkerSelection({ ...request, modelId: chosen.id })).rejects.toThrow(
      "worker_provider_unconfigured",
    );
    expect(
      (await validateWorkerSelection({ ...request, modelId: chosen.id }, chosen.provider as ProviderId)).modelId,
    ).toBe(chosen.id);
    await expect(
      validateWorkerSelection({ ...request, modelId: "unresolvable-fixture" }, chosen.provider as ProviderId),
    ).rejects.toThrow("worker_model_unavailable");
    vi.spyOn(settings, "isModelDisabled").mockReturnValue(true);
    await expect(
      validateWorkerSelection({ ...request, modelId: chosen.id }, chosen.provider as ProviderId),
    ).rejects.toThrow("worker_model_unavailable");
  });

  it("native root schemas expose explicit dispatch and forward model/effort/grants in agent and ask modes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orchestration-schema-"));
    const bash = new BashTool(cwd);
    const run = vi.fn().mockResolvedValue({ success: true, output: "saved launch receipt" });
    try {
      const tools = createBuiltinTools(bash, "agent", {
        executionRole: "orchestrator",
        runTask: run,
        runDelegation: run,
      });
      const schema = asSchema(tools.task!.inputSchema).jsonSchema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema.properties).toHaveProperty("modelId");
      expect(schema.required).toContain("modelId");
      const input = {
        agent: "general",
        description: "Owned scope",
        prompt: "Seven fields",
        modelId: "fixture-model",
        reasoningEffort: "high",
        allowedMcpTools: ["mcp_docs__read"],
        background: true,
      };
      await tools.task!.execute!(input, { toolCallId: "fixture-call", messages: [] });
      expect(run).toHaveBeenCalledWith(expect.objectContaining(input));
      const ask = createBuiltinTools(bash, "ask", { executionRole: "orchestrator", runTask: run, runDelegation: run });
      expect(ask.worker_models).toBeDefined();
      expect(ask.ee_query).toBeDefined();
      expect(String(await ask.task!.execute!(input, { toolCallId: "blocked", messages: [] }))).toContain(
        "worker_role_refused",
      );
      await ask.task!.execute!({ ...input, agent: "explore" }, { toolCallId: "read-only", messages: [] });
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "explore", modelId: "fixture-model" }));
    } finally {
      await bash.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
