import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../types/index.js";
import {
  filterExecutionTools,
  filterReviewTools,
  selectOrchestratorModel,
  validateWorkerSelection,
  workerModelIdSchema,
  workerWriteScopeRequiredError,
} from "./orchestration-policy.js";

const model = (id: string, fields: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  provider: "fixture-provider",
  tier: "fast",
  inputPrice: 0,
  outputPrice: 0,
  contextWindow: 100000,
  reasoning: true,
  supportsClientTools: true,
  description: "Fixture",
  ...fields,
});

describe("orchestrator execution policy", () => {
  it("selects provider-local eligible tier, then output/input price in stable catalog order", () => {
    const rows = [
      model("other", { provider: "other-provider", tier: "premium", outputPrice: 100 }),
      model("audio", { tier: "premium", modalities: { input: ["audio"], output: ["text"] } }),
      model("no-tools", { tier: "premium", supportsClientTools: false }),
      model("disabled", { tier: "premium", outputPrice: 100 }),
      model("balanced", { tier: "balanced", outputPrice: 20 }),
      model("first", { tier: "premium", outputPrice: 3, inputPrice: 2 }),
      model("tie", { tier: "premium", outputPrice: 3, inputPrice: 2 }),
      model("lower-input", { tier: "premium", outputPrice: 3, inputPrice: 1 }),
    ];
    expect(selectOrchestratorModel("fixture-provider", rows, (id) => id === "disabled").id).toBe("first");
    expect(() => selectOrchestratorModel("absent", rows, () => false)).toThrow(/No eligible/);
    expect(selectOrchestratorModel("fixture-provider", [model("free")], () => false).id).toBe("free");
  });

  it("admits only exact trusted native orchestration objects after all merges", () => {
    const native = {
      task: {},
      read_file: {},
      grep: {},
      bash: {},
      edit_file: {},
      write_file: {},
      ee_query: {},
      flow_status: {},
      flow_execute: {},
      flow_verify: {},
      flow_ship: {},
      flow_next: {},
    };
    const merged = {
      ...native,
      alias: native.task,
      mcp_test__task: native.task,
      read_file_alias: native.read_file,
      mcp_fs__read_file: native.read_file,
    };
    expect(Object.keys(filterExecutionTools(merged, native, "orchestrator"))).toEqual([
      "task",
      "read_file",
      "grep",
      "ee_query",
      "flow_status",
      "flow_execute",
      "flow_verify",
      "flow_ship",
    ]);
    // Workers never get the FLOW transition tools the orchestrator now owns.
    for (const name of ["flow_execute", "flow_verify", "flow_ship", "flow_next"])
      expect(filterExecutionTools(merged, native, "worker")).not.toHaveProperty(name);
    expect(filterExecutionTools({ ...merged, task: {} }, native, "orchestrator")).not.toHaveProperty("task");
    expect(filterExecutionTools({ read_file: {} }, native, "orchestrator")).not.toHaveProperty("read_file");
  });

  it("workers cannot recursively dispatch, and ambiguous MCP requires an exact per-job grant", () => {
    const native = { task: {}, delegate: {}, convene_council: {}, read_file: {}, edit_file: {}, flow_plan: {} };
    const merged = { ...native, dispatch_alias: native.task, mcp_docs__read: {}, mcp_cli__task: {} };
    const tools = filterExecutionTools(merged, native, "worker", ["mcp_docs__read", "mcp_cli__task"]);
    expect(Object.keys(tools)).toEqual(["read_file", "edit_file", "mcp_docs__read"]);
    expect(filterExecutionTools(merged, native, "worker")).not.toHaveProperty("mcp_docs__read");
  });
});

it("independent reviewers only get exact native read/test tools after MCP and aliases", () => {
  const native = {
    read_file: {},
    grep: {},
    lsp_query: {},
    verification_run: {},
    bash: {},
    edit_file: {},
    write_file: {},
    task: {},
    delegation_accept: {},
  };
  expect(
    Object.keys(filterReviewTools({ ...native, mcp_tests__verification_run: {}, renamed: native.read_file }, native)),
  ).toEqual(["read_file", "grep", "lsp_query", "verification_run"]);
  expect(filterReviewTools({ read_file: {} }, native)).toEqual({});
});

describe("worker write-scope decision (M9)", () => {
  const base = { description: "work", prompt: "do the work" };
  it("refuses an edit-capable dispatch that omits both writeScope and sharedExecution", () => {
    for (const agent of ["general", "computer", "my-custom-agent"]) {
      const error = workerWriteScopeRequiredError({ ...base, agent });
      expect(error).toMatch(/^worker_write_scope_required: agent=/);
      expect(error).toContain("No worker was started");
      expect(error).toContain("sharedExecution:true");
    }
  });
  it("admits an explicit scope, an explicit shared-execution choice, and non-editing roles", () => {
    expect(workerWriteScopeRequiredError({ ...base, agent: "general", writeScope: ["src/a.ts"] })).toBeUndefined();
    expect(workerWriteScopeRequiredError({ ...base, agent: "general", writeScope: [] })).toBeUndefined();
    expect(workerWriteScopeRequiredError({ ...base, agent: "general", sharedExecution: true })).toBeUndefined();
    expect(
      workerWriteScopeRequiredError({ ...base, agent: "verify", reviewOf: { jobId: "j", resultVersion: "v" } }),
    ).toBeUndefined();
    for (const agent of ["explore", "verify-detect", "verify", "verify-manifest", "vision"])
      expect(workerWriteScopeRequiredError({ ...base, agent })).toBeUndefined();
  });
  it("is enforced at dispatch validation before model checks", async () => {
    await expect(validateWorkerSelection({ ...base, agent: "general" })).rejects.toThrow("worker_write_scope_required");
  });
  // Session 26516fe0c62e: writeScope:[] + sharedExecution:true started a worker that could write nothing.
  it("refuses writeScope:[] combined with sharedExecution:true, keeping [] alone as the read-only grant", async () => {
    const request = { ...base, agent: "general", writeScope: [], sharedExecution: true };
    const error = workerWriteScopeRequiredError(request);
    expect(error).toMatch(/^worker_write_scope_contradiction: /);
    expect(error).toContain("No worker was started");
    expect(error).toContain("Omit writeScope for shared execution");
    await expect(validateWorkerSelection(request)).rejects.toThrow("worker_write_scope_contradiction");
    expect(workerWriteScopeRequiredError({ ...base, agent: "general", writeScope: [] })).toBeUndefined();
    expect(
      workerWriteScopeRequiredError({ ...base, agent: "general", writeScope: ["a.ts"], sharedExecution: true }),
    ).toBeUndefined();
  });
});

describe("worker modelId schema (M18)", () => {
  it("is an enum of the live inventory when known, a free string otherwise", () => {
    expect(workerModelIdSchema(["m-1", "m-2"])).toMatchObject({ type: "string", enum: ["m-1", "m-2"] });
    expect(workerModelIdSchema(undefined)).not.toHaveProperty("enum");
    expect(workerModelIdSchema([])).not.toHaveProperty("enum");
  });
});
