import { z } from "zod";
import type { ToolSet } from "ai";
import type { TaskType } from "./types.js";

const RefactorSchema = z.object({
  summary: z.string().describe("One-line summary of what changed"),
  changes: z.array(
    z.object({
      file: z.string().describe("File path"),
      diff: z.string().describe("Unified diff or replacement code"),
    }),
  ),
  verify_command: z.string().optional().describe("Command to verify the change"),
});

const DebugSchema = z.object({
  hypothesis: z.string().describe("What you think is wrong"),
  root_cause: z.string().describe("Confirmed root cause, one line"),
  fix: z.object({
    file: z.string(),
    diff: z.string().describe("Code fix as unified diff"),
  }),
  verify_command: z.string().describe("Command to verify the fix"),
});

const PlanSchema = z.object({
  steps: z.array(
    z.object({
      action: z.string().describe("Action verb + what to do"),
      criterion: z.string().describe("How to know this step is done"),
      rationale: z.string().optional().describe("Why this step"),
    }),
  ),
  assumptions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
});

const AnalyzeSchema = z.object({
  findings: z.array(
    z.object({
      text: z.string().describe("Finding description"),
      evidence: z.string().describe("file:line or direct quote"),
      severity: z.enum(["high", "medium", "low"]).describe("Impact level"),
    }),
  ),
});

const DocsSchema = z.object({
  content: z.string().describe("Markdown documentation"),
  examples: z
    .array(
      z.object({
        code: z.string(),
        description: z.string(),
      }),
    )
    .optional(),
});

const GenerateSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().describe("Output file path"),
      content: z.string().describe("Complete file content with all imports"),
      language: z.string().describe("Language identifier"),
    }),
  ),
  explanation: z.string().optional().describe("Brief design rationale"),
});

const RESPONSE_SCHEMAS: Record<TaskType, z.ZodType> = {
  refactor: RefactorSchema,
  debug: DebugSchema,
  plan: PlanSchema,
  analyze: AnalyzeSchema,
  documentation: DocsSchema,
  generate: GenerateSchema,
};

export const RESPONSE_TOOL_PREFIX = "respond_";

export function isResponseTool(toolName: string): boolean {
  return toolName.startsWith(RESPONSE_TOOL_PREFIX);
}

export function getResponseTaskType(toolName: string): TaskType | null {
  const suffix = toolName.slice(RESPONSE_TOOL_PREFIX.length);
  return suffix in RESPONSE_SCHEMAS ? (suffix as TaskType) : null;
}

export function buildResponseTools(taskType: TaskType): ToolSet {
  const schema = RESPONSE_SCHEMAS[taskType];
  if (!schema) return {};

  const toolName = `${RESPONSE_TOOL_PREFIX}${taskType}`;
  return {
    [toolName]: {
      description: `Return your ${taskType} response as structured JSON. Always use this tool to respond.`,
      inputSchema: schema,
      execute: async (input: unknown) => input,
    },
  };
}

export { RefactorSchema, DebugSchema, PlanSchema, AnalyzeSchema, DocsSchema, GenerateSchema };
