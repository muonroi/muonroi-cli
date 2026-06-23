import { describe, expect, it } from "vitest";
import {
  AnalyzeSchema,
  buildResponseTools,
  DebugSchema,
  DocsSchema,
  GeneralSchema,
  GenerateSchema,
  getResponseTaskType,
  isResponseTool,
  PlanSchema,
  RESPONSE_TOOL_PREFIX,
  RefactorSchema,
  shouldHaltOnResponseTool,
  stepEmittedResponseTool,
} from "../response-tools";

type Step = { toolCalls?: ReadonlyArray<{ toolName?: string }> };
const step = (...names: Array<string | undefined>): Step => ({
  toolCalls: names.map((toolName) => ({ toolName })),
});

describe("isResponseTool", () => {
  it("returns true for response tool names", () => {
    expect(isResponseTool("respond_refactor")).toBe(true);
    expect(isResponseTool("respond_debug")).toBe(true);
    expect(isResponseTool("respond_plan")).toBe(true);
  });

  it("returns false for action tools", () => {
    expect(isResponseTool("bash")).toBe(false);
    expect(isResponseTool("read_file")).toBe(false);
    expect(isResponseTool("edit_file")).toBe(false);
  });
});

describe("getResponseTaskType", () => {
  it("extracts task type from tool name", () => {
    expect(getResponseTaskType("respond_refactor")).toBe("refactor");
    expect(getResponseTaskType("respond_debug")).toBe("debug");
    expect(getResponseTaskType("respond_plan")).toBe("plan");
    expect(getResponseTaskType("respond_analyze")).toBe("analyze");
    expect(getResponseTaskType("respond_documentation")).toBe("documentation");
    expect(getResponseTaskType("respond_generate")).toBe("generate");
  });

  it("returns null for unknown task types", () => {
    expect(getResponseTaskType("respond_unknown")).toBeNull();
    expect(getResponseTaskType("bash")).toBeNull();
  });
});

describe("buildResponseTools", () => {
  it("returns a ToolSet with one tool for valid task type", () => {
    const tools = buildResponseTools("refactor");
    expect(Object.keys(tools)).toEqual(["respond_refactor"]);
    expect(tools.respond_refactor.description).toContain("refactor");
    expect(tools.respond_refactor.inputSchema).toBeDefined();
    expect(tools.respond_refactor.execute).toBeTypeOf("function");
  });

  it("execute returns input unchanged", async () => {
    const tools = buildResponseTools("debug");
    const input = {
      hypothesis: "test",
      root_cause: "bug",
      fix: { file: "a.ts", diff: "+" },
      verify_command: "npm test",
    };
    const result = await tools.respond_debug.execute!(input, {
      toolCallId: "1",
      messages: [],
      abortSignal: new AbortController().signal,
    });
    expect(result).toEqual(input);
  });

  it("builds tools for all 6 task types", () => {
    for (const taskType of ["refactor", "debug", "plan", "analyze", "documentation", "generate"] as const) {
      const tools = buildResponseTools(taskType);
      expect(Object.keys(tools)).toHaveLength(1);
      expect(Object.keys(tools)[0]).toBe(`${RESPONSE_TOOL_PREFIX}${taskType}`);
    }
  });
});

describe("stepEmittedResponseTool", () => {
  it("returns true when a step emitted a response tool", () => {
    expect(stepEmittedResponseTool({ toolCalls: [{ toolName: "respond_general" }] })).toBe(true);
    expect(stepEmittedResponseTool({ toolCalls: [{ toolName: "read_file" }, { toolName: "respond_analyze" }] })).toBe(
      true,
    );
  });

  it("returns false for action-only steps", () => {
    expect(stepEmittedResponseTool({ toolCalls: [{ toolName: "bash" }, { toolName: "read_file" }] })).toBe(false);
  });

  it("returns false for steps with no tool calls", () => {
    expect(stepEmittedResponseTool({ toolCalls: [] })).toBe(false);
    expect(stepEmittedResponseTool({})).toBe(false);
    expect(stepEmittedResponseTool(undefined)).toBe(false);
  });

  it("ignores malformed entries without a toolName", () => {
    expect(stepEmittedResponseTool({ toolCalls: [{}, { toolName: undefined }] })).toBe(false);
  });
});

describe("shouldHaltOnResponseTool", () => {
  it("does not halt when the last step did not emit a response tool", () => {
    expect(shouldHaltOnResponseTool([step("read_file"), step("grep")])).toBe(false);
    expect(shouldHaltOnResponseTool([])).toBe(false);
    expect(shouldHaltOnResponseTool(undefined)).toBe(false);
  });

  it("halts on a response tool emitted AFTER real tool work (terminal answer)", () => {
    // d95113d3 seq=27: 7 grep/read calls, THEN respond_general → halt at call #1.
    expect(
      shouldHaltOnResponseTool([step("grep"), step("read_file"), step("read_file"), step("respond_general")]),
    ).toBe(true);
    // Real work + response in the SAME step also counts as investigated.
    expect(shouldHaltOnResponseTool([step("read_file", "respond_analyze")])).toBe(true);
    // d95113d3 seq=3: deep investigation → single respond_analyze.
    expect(shouldHaltOnResponseTool([step("bash"), step("read_file"), step("respond_analyze")])).toBe(true);
  });

  it("does NOT halt on a single blind response tool (no prior investigation)", () => {
    // e4a9d97a90: lone blind respond_general at step 0 — give the model the
    // step it announced it would use to read code instead of force-stopping.
    expect(shouldHaltOnResponseTool([step("respond_general")])).toBe(false);
  });

  it("halts on a 2nd blind response tool with still no real work (narration loop)", () => {
    // 9b1b3: 2× blind respond_general, zero investigation → bounded at 2.
    expect(shouldHaltOnResponseTool([step("respond_general"), step("respond_general")])).toBe(true);
  });

  it("treats a blind response then real work then response as terminal (investigated)", () => {
    // Announce → investigate → answer: the final response is after real work.
    expect(shouldHaltOnResponseTool([step("respond_general"), step("read_file"), step("respond_general")])).toBe(true);
  });
});

describe("schemas validate correct input", () => {
  it("RefactorSchema accepts valid input", () => {
    const result = RefactorSchema.safeParse({
      summary: "Extract helper function",
      changes: [{ file: "src/utils.ts", diff: "- old\n+ new" }],
      verify_command: "bun test",
    });
    expect(result.success).toBe(true);
  });

  it("RefactorSchema rejects missing changes", () => {
    const result = RefactorSchema.safeParse({ summary: "test" });
    expect(result.success).toBe(false);
  });

  it("DebugSchema accepts valid input", () => {
    const result = DebugSchema.safeParse({
      hypothesis: "Race condition",
      root_cause: "Shared mutable state",
      fix: { file: "src/store.ts", diff: "+ const lock = new Mutex();" },
      verify_command: "bun test",
    });
    expect(result.success).toBe(true);
  });

  it("PlanSchema accepts valid input", () => {
    const result = PlanSchema.safeParse({
      steps: [{ action: "Add tests", criterion: "Coverage > 80%" }],
      assumptions: ["CI is green"],
    });
    expect(result.success).toBe(true);
  });

  it("AnalyzeSchema accepts valid input", () => {
    const result = AnalyzeSchema.safeParse({
      findings: [{ text: "SQL injection risk", evidence: "src/db.ts:42", severity: "high" }],
    });
    expect(result.success).toBe(true);
  });

  it("AnalyzeSchema rejects invalid severity", () => {
    const result = AnalyzeSchema.safeParse({
      findings: [{ text: "issue", evidence: "file:1", severity: "critical" }],
    });
    expect(result.success).toBe(false);
  });

  it("DocsSchema accepts valid input", () => {
    const result = DocsSchema.safeParse({
      content: "# API Reference\n\nUse `foo()` to...",
      examples: [{ code: "foo()", description: "Basic usage" }],
    });
    expect(result.success).toBe(true);
  });

  it("GenerateSchema accepts valid input", () => {
    const result = GenerateSchema.safeParse({
      files: [{ path: "src/hello.ts", content: 'console.log("hi")', language: "typescript" }],
    });
    expect(result.success).toBe(true);
  });

  it("GeneralSchema accepts valid input with response only", () => {
    const result = GeneralSchema.safeParse({ response: "The answer is 42." });
    expect(result.success).toBe(true);
  });

  it("GeneralSchema accepts valid input with optional reasoning", () => {
    const result = GeneralSchema.safeParse({ response: "Yes", reasoning: "Because it satisfies the constraints." });
    expect(result.success).toBe(true);
  });

  it("GeneralSchema rejects missing response", () => {
    const result = GeneralSchema.safeParse({ reasoning: "some reasoning" });
    expect(result.success).toBe(false);
  });
});

import { normalizeStructuredResponseTaskType } from "../response-tools";

describe("respond_general catch-all tool", () => {
  it("respond_general tool exists with correct schema", () => {
    const tools = buildResponseTools("general");
    expect(Object.keys(tools)).toEqual(["respond_general"]);
    expect(tools.respond_general.description).toContain("general");
    expect(tools.respond_general.inputSchema).toBeDefined();
    expect(tools.respond_general.execute).toBeTypeOf("function");
  });

  it("getResponseTaskType returns 'general' for 'respond_general'", () => {
    expect(getResponseTaskType("respond_general")).toBe("general");
  });

  it("isResponseTool returns true for 'respond_general'", () => {
    expect(isResponseTool("respond_general")).toBe(true);
  });
});

describe("normalizeStructuredResponseTaskType", () => {
  // Regression: session 48d22fe436f6 — model called respond_analyze but sent
  // { response: "..." } (general shape). TUI rendered empty findings box.
  it("normalizes 'analyze' → 'general' when findings missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("analyze", { response: "Some analysis text" })).toBe("general");
  });

  it("keeps 'analyze' when findings array is present", () => {
    expect(
      normalizeStructuredResponseTaskType("analyze", {
        findings: [{ text: "issue", evidence: "file:1", severity: "high" }],
      }),
    ).toBe("analyze");
  });

  it("normalizes 'debug' → 'general' when root_cause missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("debug", { response: "Bug is in the store" })).toBe("general");
  });

  it("keeps 'debug' when root_cause is present", () => {
    expect(
      normalizeStructuredResponseTaskType("debug", {
        hypothesis: "race condition",
        root_cause: "shared mutable state",
        fix: { file: "src/a.ts", diff: "+x" },
        verify_command: "bun test",
      }),
    ).toBe("debug");
  });

  it("normalizes 'plan' → 'general' when steps missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("plan", { response: "Step 1: do A" })).toBe("general");
  });

  it("normalizes 'refactor' → 'general' when changes missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("refactor", { response: "Refactored X" })).toBe("general");
  });

  it("normalizes 'documentation' → 'general' when content missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("documentation", { response: "Docs here" })).toBe("general");
  });

  it("normalizes 'generate' → 'general' when files missing but response present", () => {
    expect(normalizeStructuredResponseTaskType("generate", { response: "Generated code" })).toBe("general");
  });

  it("keeps 'general' unchanged always", () => {
    expect(normalizeStructuredResponseTaskType("general", { response: "hello" })).toBe("general");
    expect(normalizeStructuredResponseTaskType("general", {})).toBe("general");
  });

  it("does NOT normalize when response field is empty string", () => {
    expect(normalizeStructuredResponseTaskType("analyze", { response: "" })).toBe("analyze");
  });

  it("does NOT normalize when response field is whitespace-only", () => {
    expect(normalizeStructuredResponseTaskType("analyze", { response: "   " })).toBe("analyze");
  });

  it("does NOT normalize when response field is missing entirely", () => {
    expect(normalizeStructuredResponseTaskType("analyze", { summary: "Some summary" })).toBe("analyze");
  });

  it("keeps unknown taskType unchanged", () => {
    expect(normalizeStructuredResponseTaskType("unknown_type", { response: "hello" })).toBe("unknown_type");
  });
});
