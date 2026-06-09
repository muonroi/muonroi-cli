import type { ToolSet } from "ai";
import { z } from "zod";

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

const GeneralSchema = z.object({
  response: z
    .string()
    .describe(
      "Complete, full-length answer. Use rich markdown formatting (headings, bullet points, bold text, code blocks) to structure the information clearly. Avoid dense walls of text or long unformatted paragraphs. Ensure the output is highly readable and scannable for a developer. For analysis or meta questions, include all findings and evidence citations (file:line). Truncation defeats the purpose.",
    ),
  reasoning: z.string().optional().describe("Optional brief internal reasoning (not shown as primary answer)"),
});

const RESPONSE_SCHEMAS: Record<string, z.ZodType> = {
  refactor: RefactorSchema,
  debug: DebugSchema,
  plan: PlanSchema,
  analyze: AnalyzeSchema,
  documentation: DocsSchema,
  generate: GenerateSchema,
  general: GeneralSchema,
};

export const RESPONSE_TOOL_PREFIX = "respond_";

export function isResponseTool(toolName: string): boolean {
  return toolName.startsWith(RESPONSE_TOOL_PREFIX);
}

export function getResponseTaskType(toolName: string): string | null {
  const suffix = toolName.slice(RESPONSE_TOOL_PREFIX.length);
  return suffix in RESPONSE_SCHEMAS ? suffix : null;
}

/**
 * True when an AI-SDK step emitted at least one response tool (`respond_*`).
 *
 * A response tool is the model's FINAL structured answer and is terminal by
 * construction — its `execute` is identity (`input => input`), so the payload
 * lives entirely in the tool-call arguments.
 *
 * Loose step shape: the AI-SDK step type is generic over the toolset; we only
 * need each step's `toolCalls[].toolName`.
 */
export function stepEmittedResponseTool(
  step: { toolCalls?: ReadonlyArray<{ toolName?: string }> } | undefined,
): boolean {
  return Boolean(step?.toolCalls?.some((c) => Boolean(c?.toolName) && isResponseTool(c.toolName as string)));
}

/**
 * Number of *blind* (no prior investigation) response-tool steps tolerated
 * before the loop is force-halted. One blind response is allowed as a grace
 * for the "announce intent, then go investigate" pattern (session
 * e4a9d97a90); a second blind response with zero real tool work is a
 * narration loop and is halted.
 */
export const BLIND_RESPONSE_STEP_LIMIT = 2;

/**
 * Decide whether a response-tool emission should TERMINATE the streamText loop.
 *
 * A `respond_*` tool is the model's FINAL structured answer, so emitting one is
 * normally terminal. But cheap models (grok-build-0.1) sometimes emit it
 * PREMATURELY — announcing intent ("I need to inspect the code first") before
 * doing any investigation. Session e4a9d97a90: a single blind `respond_general`
 * at step 0 with zero reads; halting on the FIRST response tool unconditionally
 * (the original d95113d3 loop fix) stopped the turn and the agent never read the
 * code the user asked about ("dừng ở respond_general không làm gì tiếp").
 *
 * Discriminator — purely structural, no NLP:
 *  - REAL WORK DONE: if any earlier (or same) step in the turn called a
 *    non-response tool (read_file/grep/bash/...), the response tool is the
 *    model's CONSIDERED answer → terminal. This is the common, well-behaved
 *    path and the one d95113d3 seq=27 hit (7 grep/read calls, THEN 87×
 *    respond_general): halting on the first post-investigation response kills
 *    the loop at call #1 and costs no extra LLM round-trip.
 *  - BLIND: a response tool with no prior real work means the model answered
 *    without investigating. Allow ONE such response (grace for announce →
 *    investigate), but halt once a SECOND blind response step occurs
 *    (`>= BLIND_RESPONSE_STEP_LIMIT`) with still no real work — that is a pure
 *    narration loop (session 9b1b3: 2× blind respond_general).
 *
 * The orthogonal case of many response tools crammed into ONE generation
 * (session 8d8f498268ed: 80×) is bounded separately by the in-stream
 * RESPONSE_TOOL_SPAM_CAP in the orchestrator — stopWhen only runs BETWEEN steps.
 */
export function shouldHaltOnResponseTool(
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }> | undefined,
): boolean {
  if (!steps || steps.length === 0) return false;
  if (!stepEmittedResponseTool(steps[steps.length - 1])) return false;
  let responseSteps = 0;
  let didRealWork = false;
  for (const s of steps) {
    let stepHasResponse = false;
    for (const c of s?.toolCalls ?? []) {
      const name = c?.toolName;
      if (!name) continue;
      if (isResponseTool(name)) stepHasResponse = true;
      else didRealWork = true;
    }
    if (stepHasResponse) responseSteps += 1;
  }
  return didRealWork || responseSteps >= BLIND_RESPONSE_STEP_LIMIT;
}

export function buildResponseTools(taskType: string): ToolSet {
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

export { AnalyzeSchema, DebugSchema, DocsSchema, GeneralSchema, GenerateSchema, PlanSchema, RefactorSchema };
