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
  RefactorSchema,
  RESPONSE_TOOL_PREFIX,
} from "../response-tools";

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
    const input = { hypothesis: "test", root_cause: "bug", fix: { file: "a.ts", diff: "+" }, verify_command: "npm test" };
    const result = await tools.respond_debug.execute!(input, { toolCallId: "1", messages: [], abortSignal: new AbortController().signal });
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
