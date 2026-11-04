import type { ModelMessage } from "ai";

export const SUB_SESSION_TOOL_BOUNDARY =
  "1. Use only tools actually exposed in your current tool set, within the assignment's scope and existing permission and role boundaries. A tool name mentioned in instructions or history does not make it available.";
export const SUB_SESSION_COMPLETION_RULE =
  "3. Once the scoped work is complete, return a concise handoff to main as plain assistant text. No final-answer tool is required. Do not invent a response tool or call a tool that is absent from your current tool set. Report incomplete work and blockers explicitly.";

const OVERLAY_PREFIX =
  "You are executing a sub-task delegated by the Main Session in an isolated, temporary Sub-Session.\n";
const LEGACY_TOOL_BOUNDARY =
  "1. You have full access to tools (bash, edit_file, read_file, grep, etc.). Execute them as needed to build, debug, and verify the work.";
const LEGACY_COMPLETION_RULE =
  "3. Once the goal is achieved and verified, you MUST return your final response using the 'respond_general' (or final answer) tool.";

// Project legacy host instructions into the current working set on resume.
// Historical DB evidence, user content and unrelated system policies stay intact.
export function refreshSubSessionToolContract(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (
      message.role !== "system" ||
      typeof message.content !== "string" ||
      !message.content.startsWith(OVERLAY_PREFIX)
    ) {
      return message;
    }
    const content = message.content
      .split("\n")
      .map((line) => {
        if (line === LEGACY_TOOL_BOUNDARY) return SUB_SESSION_TOOL_BOUNDARY;
        if (line === LEGACY_COMPLETION_RULE) return SUB_SESSION_COMPLETION_RULE;
        return line;
      })
      .join("\n");
    return content === message.content ? message : { ...message, content };
  });
}
