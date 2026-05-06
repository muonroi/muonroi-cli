import type { ModelMessage } from "ai";

interface MessageLike {
  role: string;
  content: string | unknown;
}

function isCompactionSummary(msg: MessageLike): boolean {
  return (
    msg.role === "system" &&
    typeof msg.content === "string" &&
    (msg.content.startsWith("[Compaction Summary]") || msg.content.startsWith("## Session Summary"))
  );
}

function getCompactionText(msg: MessageLike): string | null {
  if (typeof msg.content !== "string") return null;
  return msg.content;
}

function extractUserText(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string; text?: string }) => c.type === "text" && c.text)
      .map((c: { text: string }) => c.text)
      .join("\n");
  }
  return "";
}

export function buildCouncilContext(messages: MessageLike[]): string {
  const parts: string[] = [];

  if (messages.length > 0 && isCompactionSummary(messages[0])) {
    const summary = getCompactionText(messages[0]);
    if (summary) {
      parts.push(`## Session Context (from compaction summary)\n${summary}`);
    }
  }

  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 5; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text.trim()) {
        userMessages.unshift(`- ${text.slice(0, 2000).trim()}`);
      }
    }
  }
  if (userMessages.length > 0) {
    parts.push(`## Recent User Messages\n${userMessages.join("\n")}`);
  }

  const councilMemories: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" && typeof msg.content === "string" && msg.content.includes("[Council Memory]")) {
      councilMemories.push(msg.content);
    }
  }
  if (councilMemories.length > 0) {
    parts.push(`## Previous Council Outcomes\n${councilMemories.slice(-2).join("\n\n")}`);
  }

  const combined = parts.join("\n\n---\n\n");
  if (combined.length > 12000) {
    return combined.slice(0, 12000) + "\n\n[... context truncated to fit token budget]";
  }
  return combined;
}
