import { asSchema, type FlexibleSchema, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { logInteraction } from "../storage/interaction-log.js";
import { logger } from "../utils/logger.js";
import { estimateMessageTokens } from "./compaction.js";
import { cumulativeMessageChars } from "./subagent-compactor.js";
import { countTokens } from "./token-counter.js";

export interface ToolSchemaMeasurement {
  name: string;
  origin: "native" | "mcp";
  nameChars: number;
  descriptionChars: number;
  inputSchemaChars: number;
  totalChars: number;
  estimatedTokens: number;
  schemaMeasured: boolean;
}

/** Character estimates of the prepared request, not provider billing tokens. */
export async function createPromptMeasurer(system: string | SystemModelMessage[], tools: ToolSet) {
  let toolsChars = 0;
  let toolsTokens = 0;
  const toolSchemas: ToolSchemaMeasurement[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const row: ToolSchemaMeasurement = {
      name,
      origin: name.startsWith("mcp_") ? "mcp" : "native",
      nameChars: name.length,
      descriptionChars: tool.description?.length ?? 0,
      inputSchemaChars: 0,
      totalChars: name.length + (tool.description?.length ?? 0),
      estimatedTokens: countTokens(`${name}\n${tool.description ?? ""}`),
      schemaMeasured: true,
    };
    try {
      const schema =
        (tool as { inputSchema?: FlexibleSchema<unknown>; parameters?: FlexibleSchema<unknown> }).inputSchema ??
        (tool as { parameters?: FlexibleSchema<unknown> }).parameters;
      if (schema) {
        const serialized = JSON.stringify(await asSchema(schema).jsonSchema);
        row.inputSchemaChars = serialized.length;
        row.totalChars += serialized.length;
        row.estimatedTokens += countTokens(serialized);
      }
    } catch (err) {
      row.schemaMeasured = false;
      logger.file("warn", "orchestrator", "Prompt schema measurement failed", {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    toolsChars += row.totalChars;
    toolsTokens += row.estimatedTokens;
    toolSchemas.push(row);
  }
  const systemChars = typeof system === "string" ? system.length : cumulativeMessageChars(system);
  const systemTokens =
    typeof system === "string" ? countTokens(system) : system.reduce((n, m) => n + estimateMessageTokens(m), 0);
  // Resolve schemas once per assembled toolset, then only measure changing messages per step.
  return Object.assign(
    (messages: readonly ModelMessage[]) => {
      const messagesChars = cumulativeMessageChars(messages);
      const toolResultsChars = cumulativeMessageChars(messages.filter((m) => m.role === "tool"));
      return {
        systemChars,
        messagesChars,
        historyChars: messagesChars - toolResultsChars,
        toolResultsChars,
        messagesCount: messages.length,
        toolsChars,
        toolsCount: Object.keys(tools).length,
        nativeToolsChars: toolSchemas
          .filter((row) => row.origin === "native")
          .reduce((sum, row) => sum + row.totalChars, 0),
        mcpToolsChars: toolSchemas.filter((row) => row.origin === "mcp").reduce((sum, row) => sum + row.totalChars, 0),
        estimatedInputTokens:
          systemTokens + toolsTokens + messages.reduce((n, m) => n + estimateMessageTokens(m) + 8, 0),
      };
    },
    { toolSchemas },
  );
}

/** Persist numeric evidence only; never copy prompt/tool text into diagnostic metadata. */
export function recordPreparedRequest(
  context: {
    sessionId?: string;
    modelId: string;
    callId: string;
    stepNumber: number;
    contextWindowTokens: number;
    reservedOutputTokens?: number;
    contextStage?: string;
    contextStageSource?: string;
    requestPhase?: "preflight" | "step";
  },
  measured: Record<string, number>,
  toolSchemas?: readonly ToolSchemaMeasurement[],
): void {
  if (!context.sessionId) return;
  const { sessionId, modelId, ...reference } = context;
  logInteraction(sessionId, "prompt_breakdown", {
    model: modelId,
    eventSubtype: "prepared",
    data: { ...reference, ...measured, ...(toolSchemas ? { toolSchemas } : {}) },
  });
}

/** Last text-budget check; compaction preferences cannot expand a model's window. */
export function assertRequestFitsContext(inputTokens: number, contextWindow: number, outputReserve = 0): void {
  if (contextWindow <= 0 || !Number.isFinite(contextWindow)) return;
  if (inputTokens + Math.max(0, outputReserve) > contextWindow) {
    throw new Error(
      `Request context overflow: estimated ${inputTokens} input tokens + ${outputReserve} reserved output tokens ` +
        `exceed the model context window (${contextWindow}). Request was not sent. Compact the session or narrow the retrieved results.`,
    );
  }
}
