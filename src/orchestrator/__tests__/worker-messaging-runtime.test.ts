import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asSchema, dynamicTool, jsonSchema, type ToolSet } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestModels,
  getTestProviders,
  registerTestProviderFactories,
} from "../../__test-helpers__/catalog-fixtures.js";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import type { BashTool } from "../../tools/bash.js";
import * as registry from "../../tools/registry.js";
import { WorkerWriteScope } from "../../tools/worker-write-scope.js";
import * as settings from "../../utils/settings.js";
import { DelegationManager, type StoredDelegation } from "../delegations.js";
import { isInteractivePaused } from "../interactive-pause.js";
import { filterExecutionTools, filterReviewTools } from "../orchestration-policy.js";
import { Agent } from "../orchestrator.js";
import { StreamRunner, type StreamRunnerDeps } from "../stream-runner.js";
import * as approvals from "../worker-approval.js";

const fixture = vi.hoisted(() => ({ mcpTools: {} as ToolSet }));
vi.mock("../../mcp/client-pool.js", () => ({
  acquireMcpTools: async () => ({ tools: fixture.mcpTools, errors: [], close: async () => {} }),
}));
let home: string, cwd: string, jobPath: string, manager: DelegationManager;
beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-message-sdk-"));
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  vi.stubEnv("MUONROI_CLI_HOME", home);
  vi.stubEnv("MUONROI_PROVIDER_STALL_TIMEOUT_MS", "40");
  const dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
  fs.mkdirSync(dir, { recursive: true });
  jobPath = path.join(dir, "owned-worker.json");
  const r: StoredDelegation = {
    id: "owned-worker",
    messagingProtocol: 1,
    agent: "general",
    kind: "task",
    description: "Message fixture",
    prompt: "Original scope",
    cwd,
    model: getTestModels().fast,
    modelId: getTestModels().fast,
    sandboxMode: "off",
    maxToolRounds: 4,
    maxTokens: 1000,
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    outputPath: path.join(dir, "owned-worker.md"),
    parentSessionId: "owner",
  };
  fs.writeFileSync(jobPath, JSON.stringify(r));
  manager = new DelegationManager(
    () => cwd,
    () => "owner",
  );
  fixture.mcpTools = {};
  vi.spyOn(settings, "getProviderStallTimeoutMs").mockReturnValue(1000);
  vi.spyOn(settings, "getProviderProgressTimeoutMs").mockReturnValue(1500);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function deps(permissionMode: "yolo" | "auto-edit" | "safe" = "yolo"): StreamRunnerDeps {
  return {
    getPermissionMode: () => permissionMode,
    resolveModelForTask: () => getTestModels().fast,
    getModelId: () => getTestModels().balanced,
    getProviderId: () => getTestProviders().default as any,
    getBash: () => ({ getCwd: () => cwd, getSandboxMode: () => "off", getSandboxSettings: () => ({}) }) as BashTool,
    getMaxToolRounds: () => 4,
    getMaxTokens: () => 1000,
    isBatchApiEnabled: () => false,
    getCrossTurnDedup: () => null,
    getReadBudget: () => null,
    recordUsage: () => {},
    setCurrentCallId: () => {},
    setLastProviderOptionsShape: () => {},
    getSessionId: () => undefined,
    runTaskRequestBatch: async () => ({ success: false, output: "Unused" }),
  };
}
describe("actual SDK worker messaging tools", () => {
  it("enforces live scope changes on captured native file tools and strips unbounded execution tools", async () => {
    const record: StoredDelegation = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    record.writeScope = ["A/"];
    record.writeScopeVersion = 1;
    record.writeScopeBinding = new WorkerWriteScope(cwd, record.writeScope).binding;
    fs.writeFileSync(jobPath, JSON.stringify(record));
    const setup = await new StreamRunner(deps()).setup({
      agent: "general",
      cwd,
      description: "Live scope",
      prompt: "Edit only A",
      writeScope: ["A/"],
      artifactJobPath: jobPath,
    });
    if (setup.kind !== "prepared") throw new Error("Expected scoped worker");
    const tools = setup.prepared.childTools;
    const call = (file_path: string, id: string) =>
      tools.write_file!.execute!({ file_path, content: "proof" }, { toolCallId: id, messages: [] }) as Promise<any>;
    try {
      for (const name of ["bash", "verification_run", "lsp_query", "git_commit", "task"])
        expect(tools[name]).toBeUndefined();
      expect(setup.prepared.childSystem).toContain("initial writeScope");
      expect(tools.worker_message).toBeDefined();
      expect((await call("A/first.txt", "write-a")).success).toBe(true);
      const blocked = await call("C/forbidden.txt", "write-c-blocked");
      expect(blocked.success).toBe(false);
      expect(blocked.writeScopeVersion).toBe(1);
      expect((await manager.sendMessage("owned-worker", "C now, not A", undefined, "scope-c", ["C/"])).success).toBe(
        true,
      );
      const allowed = await call("C/allowed.txt", "write-c-allowed");
      expect(allowed.success).toBe(true);
      expect(allowed.writeScopeVersion).toBe(2);
      expect((await call("A/after-revoke.txt", "write-a-revoked")).success).toBe(false);
      const final: StoredDelegation = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      expect(final.toolArtifacts).toHaveLength(4);
      expect(final.writeScope).toEqual(["C/"]);
      expect(final.status).toBe("running");
      expect(final.acceptance).toBeUndefined();
      expect(fs.existsSync(path.join(cwd, "A/first.txt"))).toBe(true);
      expect(fs.existsSync(path.join(cwd, "C/forbidden.txt"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "A/after-revoke.txt"))).toBe(false);
    } finally {
      await setup.prepared.childBash.cleanup();
    }
  });
  it("forwards scope decisions on the actual native owner tool API", async () => {
    const send = vi.fn(async () => ({ success: true, output: "decision" }));
    const tools = registry.createBuiltinTools(deps().getBash(), "agent", {
      executionRole: "orchestrator",
      sendDelegation: send,
    });
    await tools.delegation_send!.execute!(
      { id: "owned-worker", message: "Only A now", writeScope: ["A/"] },
      { toolCallId: "scope-decision", messages: [] },
    );
    expect(send).toHaveBeenCalledWith("owned-worker", "Only A now", undefined, "scope-decision", undefined, ["A/"]);
  });
  it.each(["", " \t\n"])("does not headless-wait an instruction with blank replyTo: %j", async (replyTo) => {
    const host = Object.create(Agent.prototype) as any;
    host.executionRole = "orchestrator";
    host.delegations = manager;
    host.waitForDelegation = vi.fn(async () => ({ success: true, output: "UNEXPECTED_WAIT" }));
    const sent = await host.sendDelegation(
      "owned-worker",
      "Correct the pattern within scope",
      replyTo,
      "blank-reply-instruction",
    );
    expect(sent.success).toBe(true);
    expect(sent.output).toContain("kind=instruction");
    expect(host.waitForDelegation).not.toHaveBeenCalled();
  });
  it("ends the worker attempt after one actual approval deadline without asking the model to retry", async () => {
    const record = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    record.permissionMode = "safe";
    record.approvalController = {
      digest: "fixture-owner",
      pid: process.pid,
      expiresAt: new Date(Date.now() + 15000).toISOString(),
    };
    fs.writeFileSync(jobPath, JSON.stringify(record));
    const original = approvals.requestWorkerApproval;
    vi.spyOn(approvals, "requestWorkerApproval").mockImplementation(
      (job, name, input, call, signal, _timeout, policy) => original(job, name, input, call, signal, 200, policy),
    );
    const handle = installMockModel({
      fixture: {
        stream: toolCallStream({
          toolCallId: "deadline-call",
          toolName: "write_file",
          input: { file_path: "must-not-exist.txt", content: "unapproved" },
        }),
      },
    });
    try {
      const result = await new StreamRunner(deps("safe")).run({
        agent: "general",
        cwd,
        description: "Bounded approval deadline",
        prompt: "Request the isolated write once",
        artifactJobPath: jobPath,
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Worker stopped after permission refusal");
      expect(handle.calls).toHaveLength(1);
      const stored = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      expect(stored.approvals).toHaveLength(1);
      expect(stored.approvals[0].state).toBe("expired");
      expect(fs.existsSync(path.join(cwd, "must-not-exist.txt"))).toBe(false);
    } finally {
      handle.uninstall();
    }
  });
  it("registers native schemas and forwards actual toolCallId; worker endpoint has no recipient", async () => {
    const send = vi.fn(async () => ({ success: true, output: "queued" }));
    const worker = vi.fn(async () => ({ success: true, output: "main" }));
    const tools = registry.createBuiltinTools(deps().getBash(), "agent", {
      executionRole: "orchestrator",
      sendDelegation: send,
      workerMessage: worker,
    });
    expect(filterExecutionTools(tools, tools, "orchestrator").delegation_send).toBeDefined();
    expect(filterExecutionTools(tools, tools, "orchestrator").worker_message).toBeUndefined();
    const schema = await asSchema(tools.worker_message!.inputSchema).jsonSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).toEqual(["kind", "message", "waitForReply", "timeoutMs"]);
    await tools.delegation_send!.execute!(
      { id: "owned-worker", message: "answer", replyTo: "question-id" },
      { toolCallId: "actual-main-sdk-id", messages: [] },
    );
    expect(send).toHaveBeenCalledWith("owned-worker", "answer", "question-id", "actual-main-sdk-id", undefined);
    await tools.worker_message!.execute!(
      { kind: "progress", message: "working" },
      { toolCallId: "actual-child-sdk-id", messages: [] },
    );
    expect(worker).toHaveBeenCalledWith("progress", "working", "actual-child-sdk-id", true, 300000, undefined);
    const fake = { ...tools.worker_message };
    expect(
      filterExecutionTools({ mcp_bad__worker_message: fake }, tools, "worker", ["mcp_bad__worker_message"]),
    ).toEqual({});
    expect(filterReviewTools(tools, tools).worker_message).toBeDefined();
  });
  it("delivers owner guidance in actual prepared SDK prompts and survives a question wait beyond both stall timers", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({
            toolCallId: "worker-progress-sdk",
            toolName: "worker_message",
            input: { kind: "progress", message: "Inspecting fixture" },
          }),
          toolCallStream({
            toolCallId: "worker-question-sdk",
            toolName: "worker_message",
            input: { kind: "question", message: "Confirm guidance?", timeoutMs: 6000 },
          }),
          textOnlyStream("WORKER_CONTINUED_AFTER_REPLY"),
        ],
      },
    });
    const original = handle.model.doStream.bind(handle.model);
    const prompts: string[] = [];
    vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return original(options);
    });
    expect(
      (await manager.sendMessage("owned-worker", "OWNER_GUIDANCE_AT_SAFE_STEP", "", "owner-guidance-sdk")).output,
    ).toContain("kind=instruction");
    const runner = new StreamRunner(deps());
    let questionId = "",
      pauseDuringWait = false;
    const reply = (async () => {
      const deadline = Date.now() + 5000;
      while (!questionId && Date.now() < deadline) {
        const r: StoredDelegation = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        questionId = r.mailbox?.messages.find((m) => m.kind === "question")?.id ?? "";
        if (!questionId) await new Promise((r) => setTimeout(r, 5));
      }
      if (!questionId) return;
      await new Promise((r) => setTimeout(r, 2200));
      pauseDuringWait = isInteractivePaused();
      expect(
        (await manager.sendMessage("owned-worker", "EXACT_OWNER_REPLY", questionId, "owner-reply-sdk")).success,
      ).toBe(true);
    })();
    try {
      const result = await runner.run({
        agent: "general",
        cwd,
        description: "Scoped messaging",
        prompt: "Original scope stays immutable",
        modelId: getTestModels().fast,
        artifactJobPath: jobPath,
      });
      await reply;
      expect(result.success).toBe(true);
      expect(result.output).toContain("WORKER_CONTINUED_AFTER_REPLY");
      expect(pauseDuringWait).toBe(true);
      expect(isInteractivePaused()).toBe(false);
      expect(prompts.every((p) => p.includes("OWNER_GUIDANCE_AT_SAFE_STEP"))).toBe(true);
      expect(prompts.at(-1)).toContain("EXACT_OWNER_REPLY");
      expect(prompts.at(-1)).toContain(questionId);
      const r: StoredDelegation = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      expect(r.mailbox!.messages.map((m) => m.toolCallId)).toEqual([
        "owner-guidance-sdk",
        "worker-progress-sdk",
        "worker-question-sdk",
        "owner-reply-sdk",
      ]);
      expect(r.status).toBe("running");
      expect(r.modelId).toBe(getTestModels().fast);
    } finally {
      handle.uninstall();
    }
  });
  it.each([
    "general",
    "verify",
  ])("%s permits host-bound communication without broadening review/source permissions", async (agent) => {
    const runner = new StreamRunner(deps(agent === "general" ? "auto-edit" : "yolo"));
    const setup = await runner.setup({
      agent,
      cwd,
      description: "Bounded worker question",
      prompt: "Original scope",
      artifactJobPath: jobPath,
      ...(agent === "verify" ? { reviewOf: { jobId: "implementation", resultVersion: "current" } } : {}),
    });
    expect(setup.kind).toBe("prepared");
    if (setup.kind !== "prepared") return;
    expect(setup.prepared.childTools.ask_user).toBeUndefined();
    expect(setup.prepared.childSystem).toContain("Use worker_message");
    try {
      expect(setup.prepared.childTools.worker_message).toBeDefined();
      if (agent === "verify") {
        expect(setup.prepared.childTools.edit_file).toBeUndefined();
        expect(setup.prepared.childTools.bash).toBeUndefined();
      }
      const result = await setup.prepared.childTools.worker_message!.execute!(
        { kind: "progress", message: "Static inspection underway" },
        { toolCallId: "review-progress", messages: [] },
      );
      expect(String(result)).toContain("sentTo=main");
      expect(setup.prepared.reviewEvidence ?? []).toHaveLength(0);
    } finally {
      await setup.prepared.childBash.cleanup();
    }
  });
  it("refuses a granted renamed MCP alias to a forbidden native object before artifact capture clones identity", async () => {
    const original = registry.createBuiltinTools;
    vi.spyOn(registry, "createBuiltinTools").mockImplementation((...args) => {
      const tools = original(...args);
      const forbidden = dynamicTool({
        description: "Forbidden native workflow",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => "MUST_NOT_RUN",
      });
      tools.flow_plan = forbidden;
      fixture.mcpTools = { mcp_alias: forbidden };
      return tools;
    });
    await expect(
      new StreamRunner(deps()).setup({
        agent: "general",
        cwd,
        description: "Identity boundary",
        prompt: "Scoped task",
        artifactJobPath: jobPath,
        allowedMcpTools: ["mcp_alias"],
      }),
    ).rejects.toThrow("required_capability_unavailable: mcp_alias");
  });
});
