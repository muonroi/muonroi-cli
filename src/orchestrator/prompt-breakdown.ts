import { asSchema, type FlexibleSchema, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { logger } from "../utils/logger.js";
import { cumulativeMessageChars } from "./subagent-compactor.js";

/** Character estimates of the prepared request, not provider billing tokens. */
export async function createPromptMeasurer(system: string | SystemModelMessage[], tools: ToolSet) {
  let toolsChars = 0;
  for (const [name, tool] of Object.entries(tools)) {
    toolsChars += name.length + (tool.description?.length ?? 0);
    try {
      const schema =
        (tool as { inputSchema?: FlexibleSchema<unknown>; parameters?: FlexibleSchema<unknown> }).inputSchema ??
        (tool as { parameters?: FlexibleSchema<unknown> }).parameters;
      if (schema) toolsChars += JSON.stringify(await asSchema(schema).jsonSchema).length;
    } catch (err) {
      logger.error("orchestrator", "Prompt schema measurement failed", {
        tool: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const systemChars = typeof system === "string" ? system.length : cumulativeMessageChars(system);
  // Resolve schemas once per assembled toolset, then only measure changing messages per step.
  return (messages: readonly ModelMessage[]) => ({
    systemChars,
    messagesChars: cumulativeMessageChars(messages),
    messagesCount: messages.length,
    toolsChars,
    toolsCount: Object.keys(tools).length,
  });
}
