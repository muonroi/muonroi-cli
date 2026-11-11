// Phase 12.3-03 — StreamRunner unit tests.
//
// Smoke-only: setup short-circuit paths (unknown agent, computer-on-textonly
// runtime), DI surface invariants. Stream integration is covered by
// tests/harness/cost-leak-{f1,g1,b3,b4,c3}.spec.ts — those exercise real
// streamText with MockLanguageModelV3.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { dynamicTool, jsonSchema, type ModelMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getTestModelForProvider,
  getTestModels,
  getTestProviders,
  registerTestProviderFactories,
} from "../../__test-helpers__/catalog-fixtures.js";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import * as mcpPool from "../../mcp/client-pool.js";
import { loadCatalog } from "../../models/registry.js";
import { ProviderRateLimitError } from "../../providers/rate-limit-backoff.js";
import {
  computePromptCacheKey,
  type ResolvedModelRuntime,
  resolveMaxOutputTokensParam,
} from "../../providers/runtime.js";
import type { BashTool } from "../../tools/bash";
import { setLiveToolSet } from "../../tools/registry.js";
import type { TaskRequest, ToolResult } from "../../types/index";
import { logger } from "../../utils/logger.js";
import * as settings from "../../utils/settings.js";
import type { CrossTurnDedup } from "../cross-turn-dedup.js";
import {
  completeDelegation,
  loadDelegation,
  readReviewArtifact,
  type StoredDelegation,
  saveDelegationToolResult,
} from "../delegations.js";
import type { ReadPathBudget } from "../read-path-budget.js";
import { prepareSubAgentPromptMessages, StreamRunner, type StreamRunnerDeps } from "../stream-runner.js";
import { FOLDED_SYSTEM_PREFIX } from "../system-message-fold.js";
import { beginToolActivity, endToolActivity, isToolActivityLive, withToolActivity } from "../tool-activity.js";
import { decideWorkerApproval, pendingWorkerApprovals } from "../worker-approval.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

describe("required worker MCP readiness", () => {
  it("refuses external termination on the actual yolo worker SDK tool path before the executor", async () => {
    const { BashTool: ActualBash } = await import("../../tools/bash.js");
    const execute = vi.spyOn(ActualBash.prototype, "execute").mockImplementation(async () => {
      throw new Error("Unexpected shell execution");
    });
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({
            toolCallId: "foreign-process",
            toolName: "bash",
            input: { command: "taskkill /PID __invalid_pid__" },
          }),
          textOnlyStream("Termination refused; no shell command was executed."),
        ],
      },
    });
    try {
      const result = await new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" })).run({
        agent: "general",
        description: "Owned process boundary",
        prompt: "Inspect only the refusal",
      });
      expect(result.success).toBe(true);
      expect(JSON.stringify(handle.model.doStreamCalls)).toContain("worker_process_boundary");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
      handle.uninstall();
    }
  });
  it("awaits the configured server for exact grants before using the child model", async () => {
    const name = "mcp_slow_docs__search";
    const config = vi
      .spyOn(settings, "loadMcpServers")
      .mockReturnValue([
        { id: "slow.docs", label: "Delayed docs", enabled: true, transport: "http", url: "http://127.0.0.1:1/mcp" },
      ]);
    const docTool = dynamicTool({
      description: "Fixture document search",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => "REQUIRED_DOCS_READY",
    });
    const acquire = vi.spyOn(mcpPool, "acquireMcpTools").mockImplementation(
      async (_servers, opts): Promise<Awaited<ReturnType<typeof mcpPool.acquireMcpTools>>> => ({
        tools: opts?.criticalServerIds?.includes("slow.docs") ? { [name]: docTool } : {},
        errors: opts?.criticalServerIds?.includes("slow.docs") ? [] : ["Delayed docs: still connecting"],
        needsKey: [],
        close: async () => {},
      }),
    );
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "required-docs", toolName: name, input: {} }),
          textOnlyStream("DOCS_PROBE_COMPLETE"),
        ],
      },
    });
    try {
      const runner = new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" }));
      const setup = await runner.setup({
        agent: "general",
        description: "Read required docs",
        prompt: "Use the granted document tool",
        allowedMcpTools: [name],
      });
      expect(setup.kind).toBe("prepared");
      expect(acquire.mock.calls[0]![1]?.criticalServerIds).toEqual(["slow.docs"]);
      if (setup.kind !== "prepared") return;
      try {
        const result = await runner.runStream(setup.prepared);
        expect(result.output).toContain("DOCS_PROBE_COMPLETE");
        expect(JSON.stringify(handle.model.doStreamCalls)).toContain("REQUIRED_DOCS_READY");
      } finally {
        await setup.prepared.closeMcp?.();
        await setup.prepared.childBash.cleanup();
      }
    } finally {
      handle.uninstall();
      acquire.mockRestore();
      config.mockRestore();
    }
  });
});

describe("worker output budget on the actual SDK request", () => {
  it.each([
    { label: "configured non-reasoning budget", reasoning: false, ceiling: 32000, omit: false },
    { label: "reasoning catalog ceiling", reasoning: true, ceiling: 64000, omit: false },
    { label: "unknown reasoning ceiling", reasoning: true, ceiling: 0, omit: false },
    { label: "unsupported output parameter", reasoning: true, ceiling: 64000, omit: true },
  ])("uses shared runtime policy for $label in both execution and bounded synthesis", async (scenario) => {
    const telemetry = await import("../prompt-breakdown.js");
    const requestLog = vi.spyOn(telemetry, "recordPreparedRequest");
    const configured = 16384;
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({
            toolCallId: "one-bounded-tool",
            toolName: "todo_write",
            input: { todos: [{ id: "proof", subject: "Record bounded progress", status: "completed" }] },
          }),
          textOnlyStream("Final evidence; no further tool was executed."),
        ],
      },
    });
    const runner = new StreamRunner(makeDeps({ getMaxTokens: () => configured }));
    const setup = await runner.setup({
      agent: "general",
      maxToolRounds: 1,
      description: "Budget fixture",
      prompt: "Inspect only the assigned evidence and report",
    });
    if (setup.kind !== "prepared") throw new Error("Expected prepared budget fixture");
    setup.prepared.childRuntime = {
      ...setup.prepared.childRuntime,
      modelInfo: {
        ...setup.prepared.childRuntime.modelInfo!,
        reasoning: scenario.reasoning,
        maxOutputTokens: scenario.ceiling,
      },
      unsupportedParams: scenario.omit ? ["maxOutputTokens"] : undefined,
    };
    const expected = resolveMaxOutputTokensParam(setup.prepared.childRuntime, configured).maxOutputTokens;
    try {
      const result = await runner.runStream(setup.prepared);
      expect(result.incomplete).toBeUndefined();
      expect(handle.model.doStreamCalls).toHaveLength(2);
      expect(handle.model.doStreamCalls[0].maxOutputTokens).toBe(expected);
      expect(handle.model.doStreamCalls[1].maxOutputTokens).toBe(expected);
      expect(requestLog.mock.calls.some(([metadata]) => metadata.reservedOutputTokens === expected)).toBe(true);
      expect(handle.model.doStreamCalls[1].tools ?? []).toHaveLength(0);
    } finally {
      requestLog.mockRestore();
      await setup.prepared.closeMcp?.();
      await setup.prepared.childBash.cleanup();
      handle.uninstall();
    }
  });
});

function makeBashStub(): BashTool {
  return {
    getCwd: () => process.cwd(),
    getSandboxMode: () => "off",
    getSandboxSettings: () => ({}),
  } as unknown as BashTool;
}

function makeDeps(overrides: Partial<StreamRunnerDeps> = {}): StreamRunnerDeps {
  const testModels = getTestModels();
  const testProviders = getTestProviders();
  return {
    resolveModelForTask: () => testModels.fast,
    getModelId: () => testModels.fast,
    getProviderId: () => testProviders.default as "anthropic",
    getBash: () => makeBashStub(),
    getMaxToolRounds: () => 50,
    getMaxTokens: () => 8192,
    isBatchApiEnabled: () => false,
    getCrossTurnDedup: () => null as CrossTurnDedup | null,
    getReadBudget: () => null as ReadPathBudget | null,
    recordUsage: () => {},
    setCurrentCallId: () => {},
    setLastProviderOptionsShape: () => {},
    getSessionId: () => undefined,
    runTaskRequestBatch: async (): Promise<ToolResult> => ({
      success: false,
      output: "batch path not exercised in this test",
    }),
    ...overrides,
  };
}

describe("nested research parent activity (55a0b3593c0f)", () => {
  it.each([
    false,
    true,
  ])("renews only an idle parent on real SDK read/text progress (explicit deadline=%s)", async (explicit) => {
    const home = mkdtempSync(join(tmpdir(), "nested-research-progress-"));
    const cwd = process.cwd();
    const env = {
      NODE_ENV: "test",
      HOME: home,
      USERPROFILE: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_AUTH_DIR: join(home, "auth"),
      MUONROI_ENV_FILE: join(home, ".env"),
      MUONROI_TOOL_ACTIVITY_MAX_MS: "1000",
      MUONROI_TOOL_ACTIVITY_GRACE_MS: "5",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    process.chdir(home);
    writeFileSync(join(home, "proof.txt"), "NESTED_READ_PROOF");
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "nested-read", toolName: "read_file", input: { file_path: "proof.txt" } }),
          textOnlyStream("NESTED_RESEARCH_COMPLETE"),
        ],
      },
    });
    let prepared: Awaited<ReturnType<StreamRunner["setup"]>> | undefined;
    let owner: number | undefined, foreign: number | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const runner = new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" }));
      prepared = await runner.setup({
        agent: "explore",
        description: "Read fixture",
        prompt: "Read proof.txt once and return the evidence",
        maxToolRounds: 3,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;
      const worker = prepared.prepared;
      const t0 = Date.now();
      let now = t0;
      owner = beginToolActivity(explicit ? 1000 : null, t0);
      foreign = beginToolActivity(null, t0);
      clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const result = await withToolActivity(owner, () =>
        runner.runStream(worker, () => {
          now = t0 + 500;
        }),
      );
      expect(result.output).toContain("NESTED_RESEARCH_COMPLETE");
      expect(JSON.stringify(handle.model.doStreamCalls)).toContain("NESTED_READ_PROOF");
      expect(isToolActivityLive(t0 + 1250, new Set([owner]))).toBe(!explicit);
      expect(isToolActivityLive(t0 + 1250, new Set([foreign]))).toBe(false);
      expect(isToolActivityLive(t0 + 2000, new Set([owner]))).toBe(false);
    } finally {
      clock?.mockRestore();
      if (owner !== undefined) endToolActivity(owner);
      if (foreign !== undefined) endToolActivity(foreign);
      if (prepared?.kind === "prepared") {
        await prepared.prepared.closeMcp?.();
        await prepared.prepared.childBash.cleanup();
      }
      handle.uninstall();
      process.chdir(cwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("StreamRunner provider errors (steady-copper-badger)", () => {
  it("mounts an exact granted MCP in a general child and exposes only its actual permitted inventory", async () => {
    const name = "mcp_fixture__read";
    const execute = vi.fn(async () => "MCP_FIXTURE_OK");
    const capability = dynamicTool({
      description: "Granted child fixture",
      inputSchema: jsonSchema({ type: "object" }),
      execute,
    });
    const acquire = vi.spyOn(mcpPool, "acquireMcpTools").mockResolvedValue({
      tools: { [name]: capability, mcp_ungranted__other: capability },
      errors: [],
      needsKey: [],
      close: async () => {},
    });
    setLiveToolSet({ mcp_parent__only: capability });
    let setup: Awaited<ReturnType<StreamRunner["setup"]>> | undefined;
    try {
      setup = await new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" })).setup({
        agent: "general",
        description: "Exact MCP fixture",
        prompt: "Read fixture",
        allowedMcpTools: [name],
      });
      expect(setup.kind).toBe("prepared");
      if (setup.kind !== "prepared") return;
      const tools = setup.prepared.childTools;
      const context = { toolCallId: "mounted-fixture", messages: [] };
      const inventory = String(await tools.list_tools!.execute!({ category: "mcp" }, context));
      expect(inventory).toContain(name);
      expect(inventory).not.toContain("mcp_parent__only");
      expect(inventory).not.toContain("mcp_ungranted__other");
      expect(String(await tools.describe_tool!.execute!({ name }, context))).toContain("Granted child fixture");
      expect(String(await tools[name]!.execute!({}, context))).toContain("MCP_FIXTURE_OK");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      acquire.mockRestore();
      setLiveToolSet(null);
      if (setup?.kind === "prepared") {
        await setup.prepared.closeMcp?.();
        await setup.prepared.childBash.cleanup();
      }
    }
  });
  it("refuses MCP grants that a read-only explore role cannot receive instead of silently discarding them", async () => {
    const setup = await new StreamRunner(makeDeps()).setup({
      agent: "explore",
      description: "Read-only grant",
      prompt: "Inspect",
      allowedMcpTools: ["mcp_fixture__read"],
    });
    try {
      expect(setup.kind).toBe("short-circuit");
      if (setup.kind === "short-circuit") expect(setup.result.output).toContain("worker_capability_role_refused");
    } finally {
      if (setup.kind === "prepared") {
        await setup.prepared.closeMcp?.();
        await setup.prepared.childBash.cleanup();
      }
    }
  });
  it("safe model-only worker completes without requiring tool approval", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("SAFE_SENTINEL") } });
    try {
      const result = await new StreamRunner(makeDeps({ getPermissionMode: () => "safe" })).run({
        agent: "explore",
        description: "No tools",
        prompt: "Reply SAFE_SENTINEL without tools",
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("SAFE_SENTINEL");
      expect(handle.model.doStreamCalls).toHaveLength(1);
    } finally {
      handle.uninstall();
    }
  });
  it("safe native read/edit/command await exact allow-once and retain catastrophic safety", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "safe-native-"));
    const jobPath = join(cwd, "job.json");
    writeFileSync(join(cwd, "fixture.txt"), "before\n");
    writeFileSync(
      jobPath,
      JSON.stringify({
        id: "safe-native",
        parentSessionId: "owner",
        status: "running",
        agent: "general",
        startedAt: new Date().toISOString(),
        outputPath: join(cwd, "out.md"),
        approvalController: {
          digest: "test-ui",
          pid: process.pid,
          expiresAt: new Date(Date.now() + 15_000).toISOString(),
        },
      }),
    );
    const setup = await new StreamRunner(makeDeps({ getPermissionMode: () => "safe" })).setup({
      agent: "general",
      cwd,
      artifactJobPath: jobPath,
      description: "Safe native fixture",
      prompt: "Use assigned fixture only",
    });
    expect(setup.kind).toBe("prepared");
    if (setup.kind !== "prepared") return;
    const invoke = async (name: string, input: unknown, call: string) => {
      let completed = false;
      const execution = Promise.resolve(
        setup.prepared.childTools[name]!.execute!(input as any, { toolCallId: call, messages: [] }),
      ).then((value) => {
        completed = true;
        return value;
      });
      let view: ReturnType<typeof pendingWorkerApprovals>[number] | undefined;
      for (let i = 0; i < 100; i++) {
        view = pendingWorkerApprovals(await loadDelegation(jobPath))[0];
        if (view) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(false);
      expect(view).toMatchObject({ toolName: name, toolCallId: call });
      if (name === "edit_file") expect(readFileSync(join(cwd, "fixture.txt"), "utf8")).toBe("before\n");
      await decideWorkerApproval(jobPath, "owner", "test-ui", view!, true);
      return execution;
    };
    try {
      expect(String(await invoke("read_file", { file_path: "fixture.txt" }, "native-read"))).toContain("before");
      await invoke("edit_file", { file_path: "fixture.txt", old_string: "before", new_string: "after" }, "native-edit");
      expect(readFileSync(join(cwd, "fixture.txt"), "utf8")).toBe("after\n");
      expect(String(await invoke("bash", { command: "echo SAFE_NATIVE_COMMAND" }, "native-command"))).toContain(
        "SAFE_NATIVE_COMMAND",
      );
      expect(String(await invoke("bash", { command: "sudo true" }, "native-dangerous"))).toMatch(
        /BLOCKED|not permitted|privilege escalation/i,
      );
      expect((await loadDelegation(jobPath)).approvals?.map((r) => r.state)).toEqual([
        "consumed",
        "consumed",
        "consumed",
        "consumed",
      ]);
    } finally {
      await setup.prepared.closeMcp?.();
      await setup.prepared.childBash.cleanup();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("external-only review inspection cannot become workspace evidence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-scope-"));
    const outside = mkdtempSync(join(tmpdir(), "review-outside-"));
    writeFileSync(join(outside, "unrelated.cjs"), "unrelated external source");
    const runner = new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" }));
    const setup = await runner.setup({
      agent: "verify",
      cwd,
      description: "Scoped review",
      prompt: "Inspect assigned source",
      reviewOf: { jobId: "implementation", resultVersion: "saved" },
    });
    try {
      expect(setup.kind).toBe("prepared");
      if (setup.kind !== "prepared") return;
      const result = await setup.prepared.childTools.read_file!.execute!(
        { file_path: join(outside, "unrelated.cjs") },
        { toolCallId: "outside-read", messages: [] },
      );
      expect(String(result)).toContain("workspace_scope_refused");
      expect(setup.prepared.reviewEvidence?.some((e) => e.success && e.scope === "workspace")).toBe(false);
    } finally {
      if (setup.kind === "prepared") await setup.prepared.childBash.cleanup();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reviews a peer MCP result through its host-bound manifest without external file access or EE", async () => {
    const home = mkdtempSync(join(tmpdir(), "peer-review-runtime-"));
    const cwd = join(home, "workspace");
    mkdirSync(cwd);
    const targetPath = join(home, "implementation.json"),
      reviewPath = join(home, "reviewer.json");
    const base = {
      agent: "general",
      kind: "task",
      description: "Recorded runtime output",
      prompt: "Private worker reasoning must not be inherited",
      cwd,
      model: getTestModels().fast,
      sandboxMode: "off",
      maxToolRounds: 4,
      maxTokens: 1000,
      status: "running",
      startedAt: new Date().toISOString(),
      parentSessionId: "fixture-main",
    };
    writeFileSync(
      targetPath,
      JSON.stringify({ ...base, id: "implementation", outputPath: join(home, "implementation.md") }),
    );
    await saveDelegationToolResult(
      targetPath,
      "peer-docs-call",
      "mcp_docs__search",
      { query: "Messaging" },
      { chunks: 5, title: "Messaging & Integration Packages" },
    );
    await completeDelegation(targetPath, "Private worker reasoning must not be inherited");
    const target = await loadDelegation(targetPath);
    const binding = { jobId: target.id, resultVersion: target.resultVersion! };
    writeFileSync(
      reviewPath,
      JSON.stringify({
        ...base,
        id: "reviewer",
        agent: "verify",
        reviewOf: binding,
        outputPath: join(home, "reviewer.md"),
        hostReview: { contextId: "fixture-review-context", sourceFingerprint: "fixture-source" },
      }),
    );
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({
            toolCallId: "review-raw-call",
            toolName: "retrieve_tool_result",
            input: { tool_call_id: "peer-docs-call" },
          }),
          textOnlyStream(
            JSON.stringify({
              verdict: "pass",
              evidence: ["Saved output contains5 chunks and Messaging & Integration Packages; no tests executed"],
            }),
          ),
        ],
      },
    });
    const runner = new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" }));
    let prepared: Awaited<ReturnType<typeof runner.setup>> | undefined;
    try {
      prepared = await runner.setup({
        agent: "verify",
        cwd,
        description: "Corroborate recorded MCP result",
        prompt: "Check the saved output only",
        artifactJobPath: reviewPath,
        reviewOf: binding,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;
      const prompt = JSON.stringify(prepared.prepared.childMessages);
      expect(prompt).toContain("peer-docs-call");
      expect(prompt).toContain(target.toolArtifacts![0]!.digest);
      expect(prompt).not.toContain(base.prompt);
      const wrong = await prepared.prepared.childTools.retrieve_tool_result!.execute!(
        { tool_call_id: binding.resultVersion },
        { toolCallId: "wrong-id", messages: [] },
      );
      expect(String(wrong)).toContain("artifact_refused");
      const result = await runner.runStream(prepared.prepared);
      expect(result.output).toContain('"pass"');
      const evidence = prepared.prepared.reviewEvidence!;
      expect(evidence).toHaveLength(2);
      expect(evidence[0]!.success).toBe(false);
      expect(evidence[1]).toMatchObject({
        tool: "retrieve_tool_result",
        success: true,
        scope: "worker-artifact",
        artifact: {
          jobId: "implementation",
          resultVersion: target.resultVersion,
          toolCallId: "peer-docs-call",
          digest: target.toolArtifacts![0]!.digest,
          offset: 0,
        },
      });
      expect(evidence[1]!.outputPreview).toContain("Messaging & Integration Packages");
      expect((await loadDelegation(reviewPath)).toolArtifacts!.map((item) => item.toolCallId)).toEqual([
        "wrong-id",
        "review-raw-call",
      ]);
    } finally {
      handle.uninstall();
      if (prepared?.kind === "prepared") await prepared.prepared.childBash.cleanup();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // The same read through an ANCESTOR alias of the delegation directory — the shape
  // of macOS /var -> /private/var and the windows runner's 8.3 TEMP (RUNNER~1),
  // reproduced on every platform with a directory link. The artifact file itself
  // being a link must still be refused.
  it("reads a peer artifact through an aliased ancestor directory but refuses a linked artifact file", async () => {
    const realHome = mkdtempSync(join(tmpdir(), "peer-artifact-alias-"));
    const home = `${realHome}-alias`;
    symlinkSync(realHome, home, process.platform === "win32" ? "junction" : "dir");
    try {
      const cwd = join(home, "workspace");
      mkdirSync(cwd);
      const targetPath = join(home, "implementation.json"),
        reviewPath = join(home, "reviewer.json");
      const base = {
        agent: "general",
        kind: "task",
        description: "Recorded runtime output",
        prompt: "p",
        cwd,
        model: getTestModels().fast,
        sandboxMode: "off",
        maxToolRounds: 4,
        maxTokens: 1000,
        status: "running",
        startedAt: new Date().toISOString(),
        parentSessionId: "fixture-main",
      };
      writeFileSync(
        targetPath,
        JSON.stringify({ ...base, id: "implementation", outputPath: join(home, "implementation.md") }),
      );
      await saveDelegationToolResult(targetPath, "peer-docs-call", "mcp_docs__search", { q: 1 }, { title: "ALIASED" });
      await completeDelegation(targetPath, "done");
      const target = await loadDelegation(targetPath);
      const binding = { jobId: target.id, resultVersion: target.resultVersion! };
      writeFileSync(
        reviewPath,
        JSON.stringify({
          ...base,
          id: "reviewer",
          agent: "verify",
          reviewOf: binding,
          outputPath: join(home, "reviewer.md"),
          hostReview: { contextId: "fixture-review-context", sourceFingerprint: "fixture-source" },
        }),
      );
      const read = await readReviewArtifact(reviewPath, binding, "peer-docs-call");
      expect(read.output).toContain("ALIASED");
      expect(read.success).toBe(true);

      const file = join(targetPath.replace(/\.json$/, ".tools"), target.toolArtifacts![0]!.fileName);
      const elsewhere = join(realHome, "elsewhere.json");
      renameSync(file, elsewhere);
      symlinkSync(elsewhere, file, "file");
      const linked = await readReviewArtifact(reviewPath, binding, "peer-docs-call");
      expect(linked.success).toBe(false);
      expect(linked.output).toContain("Linked artifact path refused.");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(realHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("fresh review has only native read/test tools and returns host executed evidence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-tools-"));
    writeFileSync(join(cwd, "value.cjs"), "module.exports=2;");
    writeFileSync(
      join(cwd, "value.test.cjs"),
      "require('node:test').test('value',()=>require('node:assert/strict').equal(require('./value.cjs'),2));",
    );
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "read-source", toolName: "read_file", input: { file_path: "value.cjs" } }),
          toolCallStream({
            toolCallId: "test-source",
            toolName: "verification_run",
            input: { files: ["value.test.cjs"], runner: "node" },
          }),
          textOnlyStream(JSON.stringify({ verdict: "pass", evidence: ["value.cjs inspected; node test passed"] })),
        ],
      },
    });
    const runner = new StreamRunner(makeDeps({ getPermissionMode: () => "yolo" }));
    try {
      const setup = await runner.setup({
        agent: "verify",
        cwd,
        description: "Fresh review",
        prompt: "Only inspect and test",
        reviewOf: { jobId: "implementation", resultVersion: "saved-version" },
      });
      expect(setup.kind).toBe("prepared");
      if (setup.kind !== "prepared") return;
      expect(Object.keys(setup.prepared.childTools).sort()).toEqual(
        ["grep", "lsp_query", "read_file", "retrieve_tool_result", "verification_run"].sort(),
      );
      expect(setup.prepared.childMessages).toHaveLength(1);
      expect(JSON.stringify(setup.prepared.childMessages)).toContain(
        "Document-only deliverables may pass static content review",
      );
      expect(JSON.stringify(setup.prepared.childMessages)).toContain("never Markdown/report files");
      const result = await runner.runStream(setup.prepared);
      expect(result.output).toContain('"pass"');
      expect(setup.prepared.reviewEvidence).toMatchObject([
        { tool: "read_file", success: true },
        { tool: "verification_run", success: true },
      ]);
      expect(setup.prepared.reviewEvidence!.every((e) => e.outputDigest.length === 64)).toBe(true);
      const refused = await setup.prepared.childTools.verification_run!.execute!(
        { cwd: tmpdir(), files: ["value.test.cjs"], runner: "node" },
        { toolCallId: "escape", messages: [] },
      );
      expect(String(refused)).toContain("workspace is fixed");
      expect(setup.prepared.reviewEvidence).toHaveLength(3);
      expect(setup.prepared.reviewEvidence![2]).toMatchObject({ success: false, scope: "unknown" });
      await setup.prepared.childBash.cleanup();
    } finally {
      handle.uninstall();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("safe detached verification refuses concrete bootstrap before side effects without owner", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "safe-bootstrap-"));
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" }, dependencies: { fixture: "1" } }),
    );
    writeFileSync(join(cwd, "package-lock.json"), "");
    try {
      await expect(
        new StreamRunner(
          makeDeps({
            getPermissionMode: () => "safe",
            getBash: () =>
              ({
                ...makeBashStub(),
                getCwd: () => cwd,
                getSandboxMode: () => "shuru",
                getSandboxSettings: () => ({}),
              }) as BashTool,
          }),
        ).setup({ agent: "verify", description: "No implicit approval", prompt: "Do not execute without approval" }),
      ).rejects.toThrow(/permission_required.*bootstrap/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("auto-edit workers refuse an approval-required computer operation without executing it", async () => {
    const setup = await new StreamRunner(makeDeps({ getPermissionMode: () => "auto-edit" })).setup({
      agent: "general",
      description: "Bounded files",
      prompt: "Inspect only",
    });
    expect(setup.kind).toBe("prepared");
    if (setup.kind !== "prepared") return;
    try {
      const tools = setup.prepared.childTools;
      expect(tools.task).toBeUndefined();
      expect(tools.delegate).toBeUndefined();
      expect(tools.convene_council).toBeUndefined();
      expect(tools.flow_execute).toBeUndefined();
      const verifyTool = tools.verification_run!;
      await expect(
        verifyTool.execute!(
          { files: ["does-not-exist-fixture.test.cjs"], runner: "node" },
          { toolCallId: "permission-probe", messages: [] },
        ),
      ).rejects.toThrow("permission_required");
    } finally {
      await setup.prepared.closeMcp?.();
      await setup.prepared.childBash.cleanup();
    }
  });
  it("projects stages from actual native read/edit/test results without context_load calls", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "observed-stage-stream-"));
    writeFileSync(join(cwd, "fixture.txt"), "before\n");
    writeFileSync(join(cwd, "fixture.test.cjs"), "require('node:test').test('fixture',()=>{});");
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "observed-read", toolName: "read_file", input: { file_path: "fixture.txt" } }),
          toolCallStream({
            toolCallId: "observed-edit",
            toolName: "edit_file",
            input: { file_path: "fixture.txt", old_string: "before", new_string: "after" },
          }),
          toolCallStream({
            toolCallId: "observed-tests",
            toolName: "verification_run",
            input: { files: ["fixture.test.cjs"], runner: "node" },
          }),
          textOnlyStream("Completed fixture checks"),
        ],
      },
    });
    const runner = new StreamRunner(makeDeps());
    const setup = await runner.setup({
      agent: "general",
      cwd,
      description: "Isolated fixture",
      prompt: "Read, edit and verify only fixture.txt",
    });
    try {
      expect(setup.kind).toBe("prepared");
      if (setup.kind !== "prepared") return;
      await runner.runStream(setup.prepared);
      expect(handle.model.doStreamCalls).toHaveLength(4);
      for (const [index, stage] of ["orient", "research", "implement", "verify"].entries()) {
        const prompt = JSON.stringify(handle.model.doStreamCalls[index]!.prompt);
        expect(prompt).toContain(`stage=${stage}`);
      }
    } finally {
      if (setup.kind === "prepared") {
        await setup.prepared.closeMcp?.();
        await setup.prepared.childBash.cleanup();
      }
      handle.uninstall();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("projects actual child stage changes on each SDK request without mutating the prepared history", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({
            toolCallId: "load-stage",
            toolName: "context_load",
            input: { stage: "verify", expected_revision: 0, handoff: "retain proof=child-evidence" },
          }),
          textOnlyStream("Verified bounded child evidence"),
        ],
      },
    });
    const runner = new StreamRunner(makeDeps());
    const setup = await runner.setup({
      agent: "explore",
      description: "Assigned evidence review",
      prompt: "Inspect only the assigned evidence",
    });
    expect(setup.kind).toBe("prepared");
    if (setup.kind !== "prepared") {
      handle.uninstall();
      return;
    }
    const canonical = JSON.stringify(setup.prepared.childMessages);
    try {
      await runner.runStream(setup.prepared);
      expect(handle.model.doStreamCalls).toHaveLength(2);
      const first = JSON.stringify(handle.model.doStreamCalls[0]!.prompt);
      const second = JSON.stringify(handle.model.doStreamCalls[1]!.prompt);
      expect(first).toContain("stage=research");
      expect(second).toContain("stage=verify");
      expect(second).not.toContain("stage=research");
      expect(second).toContain("proof=child-evidence");
      expect(JSON.stringify(setup.prepared.childMessages)).toBe(canonical);
    } finally {
      await setup.prepared.closeMcp?.();
      await setup.prepared.childBash.cleanup();
      handle.uninstall();
    }
  });
  it("blocks an oversized prepared child request without contacting the provider", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("must not run") } });
    const runner = new StreamRunner(makeDeps());
    const outcome = await runner.setup({ agent: "explore", description: "Read", prompt: "Read evidence" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") {
      handle.uninstall();
      return;
    }
    try {
      outcome.prepared.childRuntime = {
        ...outcome.prepared.childRuntime,
        modelInfo: { ...outcome.prepared.childRuntime.modelInfo!, contextWindow: 12000 },
      };
      outcome.prepared.childMessages = [{ role: "user", content: "oversized history ".repeat(30000) }];
      await expect(runner.runStream(outcome.prepared)).rejects.toThrow(/Request context overflow/);
      expect(handle.model.doStreamCalls).toHaveLength(0);
    } finally {
      await outcome.prepared.closeMcp?.();
      await outcome.prepared.childBash.cleanup();
      handle.uninstall();
    }
  });

  it("logs the provider trace and raw body retained through an exhausted retry wrapper", async () => {
    const cause = new APICallError({
      message: "Rate limited",
      url: "https://provider.example.invalid",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: '{"error":{"type":"rate_limited"}}',
      responseHeaders: { "x-trace-id": "delegated-trace-fixture", "retry-after": "6" },
    });
    const error = new ProviderRateLimitError({ attempts: 2, waitedMs: 4000, cause });
    const handle = installMockModel({ fixture: { stream: [{ type: "error", error }] } });
    const log = vi.spyOn(logger, "error");
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "explore",
        description: "Inspect",
        prompt: "Read evidence",
      });
      expect(result.success).toBe(false);
      expect(log).toHaveBeenCalledWith(
        "orchestrator",
        "[stream-runner] delegated task failed",
        expect.objectContaining({
          statusCode: 429,
          stage: "subagent",
          traceId: "delegated-trace-fixture",
          responseBody: cause.responseBody,
          responseHeaders: { "x-trace-id": "delegated-trace-fixture", "retry-after": "6" },
        }),
      );
      expect(handle.model.doStreamCalls).toHaveLength(1);
    } finally {
      log.mockRestore();
      handle.uninstall();
    }
  });
  it("fails final synthesis without replaying tools that already ran", async () => {
    const error = new APICallError({
      message: "Synthesis rate limited",
      url: "https://provider.example.invalid",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "todo", toolName: "todo_write", input: { todos: [] } }),
          [{ type: "error", error }],
        ],
      },
    });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "explore",
        maxToolRounds: 1,
        description: "Inspect",
        prompt: "Read evidence",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("HTTP 429: Synthesis rate limited");
      expect(handle.model.doStreamCalls).toHaveLength(2);
    } finally {
      handle.uninstall();
    }
  });
  it("recovers a local synthesis schema failure without replaying tools or logging prompt values", async () => {
    const first = toolCallStream({ toolCallId: "one-completed-effect", toolName: "todo_write", input: { todos: [] } });
    const call = first.find((part) => part.type === "tool-call")!;
    // A deliberately invalid provider metadata value: valid tool work has already finished.
    (call as any).providerMetadata = { fixture: { invalid: new Date("2026-01-01T00:00:00Z") } };
    const handle = installMockModel({
      fixture: { stream: [first, textOnlyStream("RECOVERED_SCOPED_REPORT; acceptance remains unverified")] },
    });
    const runner = new StreamRunner(makeDeps());
    const setup = await runner.setup({
      agent: "explore",
      maxToolRounds: 1,
      description: "Schema fixture",
      prompt: "Inspect assigned evidence; PRIVATE_PROMPT_SENTINEL",
    });
    if (setup.kind !== "prepared") throw new Error("Expected prepared schema fixture");
    const original = setup.prepared.childTools.todo_write!.execute!;
    const effect = vi.fn(original);
    setup.prepared.childTools.todo_write!.execute = effect;
    const log = vi.spyOn(logger, "file");
    try {
      const result = await runner.runStream(setup.prepared);
      expect(result.output).toContain("RECOVERED_SCOPED_REPORT");
      expect(effect).toHaveBeenCalledTimes(1);
      expect(handle.model.doStreamCalls).toHaveLength(2);
      expect(handle.model.doStreamCalls[1].tools ?? []).toHaveLength(0);
      const reports = log.mock.calls.filter(([, , message]) => message === "Worker synthesis prompt schema recovery");
      expect(reports).toHaveLength(1);
      expect(JSON.stringify(reports)).not.toContain("PRIVATE_PROMPT_SENTINEL");
      expect(JSON.stringify(reports)).toContain("providerOptions");
    } finally {
      log.mockRestore();
      await setup.prepared.closeMcp?.();
      await setup.prepared.childBash.cleanup();
      handle.uninstall();
    }
  });
  it("still synthesizes a bounded final after a tool cap when preparatory prose already flowed", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [
          [
            ...textOnlyStream("I will read first.").slice(0, -1),
            ...toolCallStream({
              toolCallId: "once",
              toolName: "todo_write",
              input: { todos: [{ id: "proof", subject: "Record one step", status: "completed" }] },
            }).slice(1),
          ],
          textOnlyStream("FINAL_BOUNDED_EVIDENCE; pending edits remain explicit."),
        ],
      },
    });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "explore",
        maxToolRounds: 1,
        description: "Read bounded evidence",
        prompt: "Inspect only",
      });
      expect(result.output).toContain("FINAL_BOUNDED_EVIDENCE");
      expect(handle.model.doStreamCalls).toHaveLength(2);
      expect(handle.model.doStreamCalls[1].tools ?? []).toHaveLength(0);
    } finally {
      handle.uninstall();
    }
  });
  it.each([
    "bounded final",
    "empty final",
  ])("does not promote an earlier preamble when the terminal SDK step is empty: %s", async (mode) => {
    const first = [
      ...textOnlyStream("I will apply the three edits. First, section 4.").slice(0, -1),
      ...toolCallStream({
        toolCallId: "one-observed-action",
        toolName: "todo_write",
        input: { todos: [{ id: "first-only", subject: "One observed action", status: "completed" }] },
      }).slice(1),
    ];
    const handle = installMockModel({
      fixture: {
        stream: [
          first,
          textOnlyStream(""),
          textOnlyStream(mode === "bounded final" ? "Only the first action ran; two changes remain unverified." : ""),
        ],
      },
    });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "general",
        description: "Apply three scoped changes",
        prompt: "Report completed and pending changes separately",
      });
      expect(handle.model.doStreamCalls).toHaveLength(3);
      expect(handle.model.doStreamCalls[2].tools ?? []).toHaveLength(0);
      expect(result.success).toBe(mode === "bounded final");
      if (mode === "bounded final") {
        expect(result.output).toBe("Only the first action ran; two changes remain unverified.");
        expect(result.output).not.toContain("I will apply");
      } else expect(result.error).toContain("worker_incomplete");
      // The completed tool call is in the original execution only; recovery
      // cannot replay edits because the extra request has no tools.
      expect(JSON.stringify(handle.model.doStreamCalls[2].prompt)).toContain("one-observed-action");
    } finally {
      handle.uninstall();
    }
  });
  it.each([
    "normal",
    "length",
  ])("preserves a real terminal outcome without another recovery request: %s", async (mode) => {
    const first = [
      ...textOnlyStream("Earlier progress only").slice(0, -1),
      ...toolCallStream({
        toolCallId: "one-action",
        toolName: "todo_write",
        input: { todos: [{ id: "one", subject: "One action", status: "completed" }] },
      }).slice(1),
    ];
    const terminal = textOnlyStream(mode === "normal" ? "Final scoped result and remaining limits" : "");
    const finish = terminal.at(-1)!;
    if (mode === "length" && finish.type === "finish") finish.finishReason = { unified: "length", raw: "length" };
    const handle = installMockModel({ fixture: { stream: [first, terminal] } });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "general",
        description: "Scoped task",
        prompt: "Return the final result",
      });
      // An empty terminal step cut by the output limit (no text, no tool call:
      // the budget went to reasoning — calm-copper-otter, session 8a5bd89c2be0)
      // now gets ONE tool-free re-ask; a still-empty answer stays incomplete.
      expect(handle.model.doStreamCalls).toHaveLength(mode === "normal" ? 2 : 3);
      expect(result.success).toBe(mode === "normal");
      if (mode === "normal") expect(result.output).toBe("Final scoped result and remaining limits");
      else {
        expect(result.error).toContain("output limit");
        expect(handle.model.doStreamCalls[2].tools ?? []).toHaveLength(0);
        expect(JSON.stringify(handle.model.doStreamCalls[2].prompt)).toContain("spent its whole output budget");
      }
    } finally {
      handle.uninstall();
    }
  });
  it.each([
    "/compact Continue pending edits",
    "/compact Tiếp tục sửa báo cáo tiếng Việt",
  ])("does not claim completion for a context-continuation request: %s", async (output) => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream(output) } });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "general",
        description: "Repair report",
        prompt: "Edit the assigned report",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("worker_incomplete");
      expect(result.output).toContain(output);
      expect(handle.model.doStreamCalls).toHaveLength(1);
    } finally {
      handle.uninstall();
    }
  });
  it("keeps a normal Vietnamese final and a quoted /compact command valid", async () => {
    const text = "Đã sửa báo cáo. Ví dụ lệnh: `/compact giữ bằng chứng`. Không thực thi lệnh này.";
    const handle = installMockModel({ fixture: { stream: textOnlyStream(text) } });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "general",
        description: "Report result",
        prompt: "Return findings",
      });
      expect(result.success).toBe(true);
      expect(result.output).toBe(text);
      expect(handle.model.doStreamCalls).toHaveLength(1);
    } finally {
      handle.uninstall();
    }
  });
  it("does not promote preparatory text when the bounded final is empty", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [
          [
            ...textOnlyStream("Preparatory text only").slice(0, -1),
            ...toolCallStream({
              toolCallId: "once",
              toolName: "todo_write",
              input: { todos: [{ id: "proof", subject: "Record one step", status: "completed" }] },
            }).slice(1),
          ],
          textOnlyStream(""),
        ],
      },
    });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "explore",
        maxToolRounds: 1,
        description: "Inspect",
        prompt: "Read",
      });
      expect(result.success).toBe(false);
      expect(handle.model.doStreamCalls).toHaveLength(2);
    } finally {
      handle.uninstall();
    }
  });
  it("reports a truncated final as incomplete after bounded tool-free continuations", async () => {
    const parts = textOnlyStream("Truncated final");
    const finish = parts.at(-1)!;
    if (finish.type === "finish") finish.finishReason = { unified: "length", raw: "length" };
    const handle = installMockModel({ fixture: { stream: parts } });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "general",
        description: "Report",
        prompt: "Return findings",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("output limit");
      expect(result.error).toContain("configuredOutputTokens=");
      expect(result.error).toContain("effectiveMaxOutputTokens=");
      expect(result.output).toContain("Truncated final");
      // keen-blue-lynx (session 8a5bd89c2be0): a cut answer gets at most
      // MAX_LENGTH_CONTINUATIONS tool-free follow-ups; the fixture keeps
      // answering "length", so the result stays labelled incomplete.
      expect(handle.model.doStreamCalls).toHaveLength(3);
      for (const call of handle.model.doStreamCalls.slice(1)) expect(call.tools ?? []).toHaveLength(0);
    } finally {
      handle.uninstall();
    }
  });
  it("logs actual SDK schema paths without leaking prompt values or replaying the model", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("must not be called") } });
    const log = vi.spyOn(logger, "error");
    const runner = new StreamRunner(makeDeps());
    const setup = await runner.setup({ agent: "explore", description: "Schema fixture", prompt: "Inspect" });
    if (setup.kind !== "prepared") throw new Error("Expected prepared fixture");
    setup.prepared.childMessages = [
      {
        role: "user",
        content: [
          { type: "text", text: 42 },
          { type: "text", text: "PRIVATE_SENTINEL tiếng Việt" },
        ],
      },
    ] as any;
    vi.spyOn(runner, "setup").mockResolvedValue(setup);
    try {
      const result = await runner.run({ agent: "explore", description: "Schema fixture", prompt: "Inspect" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("ModelMessage[] schema");
      expect(handle.model.doStreamCalls).toHaveLength(0);
      expect(log).toHaveBeenCalledWith(
        "orchestrator",
        "[stream-runner] delegated task failed",
        expect.objectContaining({
          promptIssues: expect.arrayContaining([expect.objectContaining({ path: [0], code: "invalid_union" })]),
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    } finally {
      log.mockRestore();
      handle.uninstall();
    }
  });
  it("retains partial output and does not replay a transient failure after text flowed", async () => {
    const error = new APICallError({
      message: "Retry later",
      url: "https://provider.example.invalid",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    const parts = textOnlyStream("PARTIAL_EVIDENCE");
    const handle = installMockModel({
      fixture: { stream: [...parts.filter((part) => part.type !== "finish"), { type: "error", error }] },
    });
    try {
      const result = await new StreamRunner(makeDeps()).run({
        agent: "explore",
        description: "Inspect",
        prompt: "Read evidence",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("PARTIAL_EVIDENCE");
      expect(result.output).toContain("HTTP 429: Retry later");
      expect(handle.model.doStreamCalls).toHaveLength(1);
    } finally {
      handle.uninstall();
    }
  });
  it.each(
    [400, 401, 429].flatMap((statusCode) => ["part", "throw"].map((kind) => ({ statusCode, kind }))),
  )("preserves HTTP $statusCode errors emitted as $kind by the actual SDK", async ({ statusCode, kind }) => {
    const error = new APICallError({
      message: "Provider rejected the delegated request",
      url: "https://provider.example.invalid/v1/responses",
      requestBodyValues: {},
      statusCode,
      responseBody: '{"error":"fixture rejection"}',
      isRetryable: statusCode === 429,
    });
    const handle = installMockModel({ fixture: { stream: [{ type: "error", error }] } });
    const streamSpy = kind === "throw" ? vi.spyOn(handle.model, "doStream").mockRejectedValue(error) : undefined;
    try {
      const pending = new StreamRunner(makeDeps()).run({
        agent: "explore",
        description: "Inspect",
        prompt: "Read evidence",
      });
      if (statusCode === 429) {
        await expect(pending).rejects.toBe(error);
      } else {
        const result = await pending;
        expect(result.success).toBe(false);
        expect(result.output).toContain(error.message);
        expect(result.output).not.toContain("No output generated");
      }
    } finally {
      streamSpy?.mockRestore();
      handle.uninstall();
    }
  });
});

describe("StreamRunner — setup short-circuit paths", () => {
  it("keeps an admitted explore child's shell locked to the main plan even with a different cwd", async () => {
    const main = mkdtempSync(join(tmpdir(), "explore-gate-"));
    const child = join(main, "child");
    mkdirSync(join(main, ".planning"));
    mkdirSync(child);
    writeFileSync(
      join(main, ".planning", "STATE.md"),
      "| Field | Value |\n|---|---|\n| Phase | plan |\n| Depth | heavy |\n",
    );
    writeFileSync(join(main, ".planning", "PLAN-VERIFY.md"), "verdict: revise\n");
    vi.stubEnv("MUONROI_FLOW_NATIVE", "1");
    vi.stubEnv("MUONROI_FLOW_HARD_GATE", "1");
    const deps = makeDeps({ getBash: () => ({ ...makeBashStub(), getCwd: () => main }) as BashTool });
    let prepared: Awaited<ReturnType<StreamRunner["setup"]>> | undefined;
    try {
      prepared = await new StreamRunner(deps).setup({
        agent: "explore",
        description: "Read only",
        prompt: "Inspect assigned evidence",
        cwd: child,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") return;
      const tools = prepared.prepared.childTools;
      for (const name of ["write_file", "edit_file", "task", "delegate", "git_commit"])
        expect(tools[name]).toBeUndefined();
      const result = await tools.bash.execute!({ command: "touch gate-escape-proof" }, {} as never);
      expect(result).toContain("BLOCKED:");
      expect(existsSync(join(child, "gate-escape-proof"))).toBe(false);
      expect(existsSync(join(main, "gate-escape-proof"))).toBe(false);
    } finally {
      if (prepared?.kind === "prepared") await prepared.prepared.childBash.cleanup();
      vi.unstubAllEnvs();
    }
  });
  it("reports the exact granted tool inventory and explicit execution cwd", async () => {
    const outcome = await new StreamRunner(makeDeps()).setup({
      agent: "explore",
      description: "inspect",
      prompt: "Read evidence",
      cwd: ".scratch",
    });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    expect(outcome.prepared.childBash.getCwd().replace(/\\/g, "/")).toBe(
      `${process.cwd().replace(/\\/g, "/")}/.scratch`,
    );
    expect(outcome.prepared.childSystem).toContain(
      `Actual tools granted to this child: ${Object.keys(outcome.prepared.childTools).sort().join(", ")}.`,
    );
    expect(outcome.prepared.childTools.retrieve_tool_result).toBeDefined();
    expect(outcome.prepared.childTools.ee_query).toBeDefined();
    expect(outcome.prepared.childTools.write_file).toBeUndefined();
    expect(outcome.prepared.childTools.edit_file).toBeUndefined();
    expect(outcome.prepared.childTools.task).toBeUndefined();
    await outcome.prepared.childBash.cleanup();
  });

  it("returns unknown-agent short-circuit when agent kind is not recognised", async () => {
    const runner = new StreamRunner(makeDeps());
    const request: TaskRequest = {
      agent: "definitely-not-a-real-agent",
      description: "test",
      prompt: "noop",
    };
    const outcome = await runner.setup(request);
    expect(outcome.kind).toBe("short-circuit");
    if (outcome.kind === "short-circuit") {
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.output).toContain(`Unknown sub-agent "definitely-not-a-real-agent"`);
      expect(outcome.result.task?.agent).toBe("definitely-not-a-real-agent");
    }
  });

  it("returns the same ToolResult shape that the in-line orchestrator did (parity check)", async () => {
    // The pre-12.3 orchestrator returned { success: false, output: <msg>,
    // task: { agent, description, summary: <msg> } } for unknown agents. Pin
    // that shape so a future refactor that drops `task.summary` is caught.
    const runner = new StreamRunner(makeDeps());
    const outcome = await runner.setup({ agent: "??", description: "d", prompt: "p" } as TaskRequest);
    expect(outcome.kind).toBe("short-circuit");
    if (outcome.kind === "short-circuit") {
      expect(outcome.result.task?.description).toBe("d");
      expect(outcome.result.task?.summary).toEqual(outcome.result.output);
    }
  });
});

describe("StreamRunner — cheap-model steering on sub-agent system prompt", () => {
  // The sub-agent prompt must carry the SAME front-loaded steering stack as the
  // top-level turn for fast-tier models (regression: previously only the
  // playbook was injected, leaving the sub-agent without the anti-ramble
  // workbook or the shell directive). Final prompt order: [ENV] → [CRITICAL
  // playbook] → [CONVERGENCE workbook] → base.
  //
  // `explore` is used because its childMode is "ask" (no MCP load) so setup()
  // completes synchronously without spawning anything.
  it("front-loads [ENV] → [CRITICAL] → [CONVERGENCE] for a fast-tier explore sub-agent", async () => {
    const runner = new StreamRunner(makeDeps());
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const sys = outcome.prepared.childSystem;

    const iEnv = sys.indexOf("[ENV]");
    const iCritical = sys.indexOf("[CRITICAL TOOL-USE RULES");
    const iConvergence = sys.indexOf("[CONVERGENCE");
    expect(sys.startsWith("[ENV]")).toBe(true);
    expect(iEnv).toBeGreaterThanOrEqual(0);
    expect(iCritical).toBeGreaterThan(iEnv);
    expect(iConvergence).toBeGreaterThan(iCritical);
    // explore → analyze workbook addendum.
    expect(sys).toMatch(/do not read the whole codebase/i);
  });
});

describe("StreamRunner — F1 promptCacheKey parity on the sub-agent path", () => {
  // The top-level turn derives a stable openai.promptCacheKey per turn via
  // buildTurnProviderOptions({ sessionId }) so every tool round in a session
  // routes to the same cache node (message-processor.ts). The sub-agent path
  // previously used only resolve-time childRuntime.providerOptions, which has
  // NO promptCacheKey — so every explore/verify OpenAI call auto-hashed its
  // prompt and fragmented the cache, re-billing the unchanging prefix. setup()
  // must now thread the session id so sub-agents get the SAME stable key.
  it("threads sessionId → openai.promptCacheKey onto the sub-agent providerOptions", async () => {
    const sessionId = "sess-fixed-for-f1-parity";
    const openaiModel = getTestModelForProvider("openai", "fast");
    const runner = new StreamRunner(
      makeDeps({
        resolveModelForTask: () => openaiModel,
        getSessionId: () => sessionId,
      }),
    );
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const opts = outcome.prepared.childProviderOptions as { openai?: { promptCacheKey?: string } } | undefined;
    expect(opts?.openai?.promptCacheKey).toBe(computePromptCacheKey(sessionId));
  });

  it("omits promptCacheKey when there is no session id (headless one-shot)", async () => {
    const openaiModel = getTestModelForProvider("openai", "fast");
    const runner = new StreamRunner(
      makeDeps({
        resolveModelForTask: () => openaiModel,
        getSessionId: () => undefined,
      }),
    );
    const outcome = await runner.setup({ agent: "explore", description: "scan", prompt: "find auth wiring" });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind !== "prepared") return;
    const opts = outcome.prepared.childProviderOptions as { openai?: { promptCacheKey?: string } } | undefined;
    expect(opts?.openai?.promptCacheKey).toBeUndefined();
  });
});

describe("StreamRunner — DI surface", () => {
  it("constructs without invoking any dep callbacks", () => {
    let touched = 0;
    const trip = (): never => {
      touched++;
      throw new Error("touched");
    };
    // Every callback throws — instantiation must not call any of them.
    const runner = new StreamRunner({
      resolveModelForTask: trip as unknown as () => string,
      getModelId: trip as unknown as () => string,
      getProviderId: trip as unknown as () => "anthropic",
      getBash: trip as unknown as () => BashTool,
      getMaxToolRounds: trip as unknown as () => number,
      getMaxTokens: trip as unknown as () => number,
      isBatchApiEnabled: trip as unknown as () => boolean,
      getCrossTurnDedup: trip as unknown as () => CrossTurnDedup | null,
      getReadBudget: trip as unknown as () => ReadPathBudget | null,
      recordUsage: trip,
      setCurrentCallId: trip,
      setLastProviderOptionsShape: trip,
      getSessionId: trip as unknown as () => string | undefined,
      // Derive the stub's type from the DI surface itself — an inline copy of
      // the arg shape silently drifts every time the surface gains a field.
      runTaskRequestBatch: trip as unknown as StreamRunnerDeps["runTaskRequestBatch"],
    });
    expect(runner).toBeInstanceOf(StreamRunner);
    expect(touched).toBe(0);
  });

  it("each runner instance is independent (no shared mutable state on the class)", () => {
    const a = new StreamRunner(makeDeps());
    const b = new StreamRunner(makeDeps());
    expect(a).not.toBe(b);
  });

  describe("StreamRunner — maxSteps custom overrides", () => {
    it("respects default maxSteps logic when request.maxToolRounds is undefined", async () => {
      const deps = makeDeps({ getMaxToolRounds: () => 50 });
      const runner = new StreamRunner(deps);
      const outcome = await runner.setup({
        agent: "explore",
        description: "test",
        prompt: "test",
      });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind === "prepared") {
        expect(outcome.prepared.maxSteps).toBe(100); // deps.getMaxToolRounds() * 2
      }
    });

    it("uses request.maxToolRounds when it is explicitly defined", async () => {
      const deps = makeDeps({ getMaxToolRounds: () => 50 });
      const runner = new StreamRunner(deps);
      const outcome = await runner.setup({
        agent: "explore",
        description: "test",
        prompt: "test",
        maxToolRounds: 75,
      });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind === "prepared") {
        expect(outcome.prepared.maxSteps).toBe(75);
      }
    });
  });

  // Round 2 fix (G1-adjacent MEDIUM): a sub-agent's prepareStep callback used
  // to fold mid-conversation system messages ONLY for a Claude child model —
  // a non-Claude sub-agent child got a mid-conversation system message raw,
  // unlike the main tool-engine.ts path, which folds for every provider.
  describe("prepareSubAgentPromptMessages (G1-adjacent MEDIUM: fold for every provider)", () => {
    const midConversationSystem: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "system", content: "guidance injected mid-conversation" },
    ];

    it("folds a mid-conversation system message for a NON-Claude model (was Claude-only)", () => {
      const result = prepareSubAgentPromptMessages(midConversationSystem, "deepseek-v4-flash");
      // No mid-conversation system message left — every provider's
      // alternation rule (and Anthropic's outright rejection of a system
      // message separated from the leading block by user/assistant turns)
      // is respected the same way the main path already guarantees.
      expect(result.some((m) => m.role === "system")).toBe(false);
      const folded = result.find(
        (m) => typeof m.content === "string" && m.content.includes("guidance injected mid-conversation"),
      );
      expect(folded).toBeDefined();
      expect(folded?.content).toContain(FOLDED_SYSTEM_PREFIX);
    });

    it("still folds for a Claude model (no regression — same behaviour as before this fix)", () => {
      const result = prepareSubAgentPromptMessages(midConversationSystem, "claude-sonnet-4-6");
      expect(result.some((m) => m.role === "system")).toBe(false);
    });

    it("a leading system message (not mid-conversation) is left alone for every provider", () => {
      const leadingOnly: ModelMessage[] = [
        { role: "system", content: "leading guidance" },
        { role: "user", content: "hi" },
      ];
      const nonClaude = prepareSubAgentPromptMessages(leadingOnly, "deepseek-v4-flash");
      const claude = prepareSubAgentPromptMessages(leadingOnly, "claude-sonnet-4-6");
      expect(nonClaude[0]).toMatchObject({ role: "system", content: "leading guidance" });
      // Claude may additionally get cache-control metadata attached, but the
      // message stays a single leading system entry, not folded away.
      expect(claude.filter((m) => m.role === "system")).toHaveLength(1);
    });
  });
});
