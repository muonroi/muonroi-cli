import type { ModelMessage } from "ai";

/** Only an explicit assistant directive in the active user turn controls compaction. */
export function readContextPreservation(messages: readonly ModelMessage[]) {
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start--;
  let preserveFullContext = false;
  const keepToolIds = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "assistant") continue;
    const texts =
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            (part.type === "text" || part.type === "reasoning") && typeof part.text === "string" ? [part.text] : [],
          );
    for (const text of texts) {
      if (/^\s*PRESERVE_FULL_CONTEXT\s*$/m.test(text)) preserveFullContext = true;
      for (const match of text.matchAll(/^\s*KEEP_TOOL_IDS\s*:\s*([^\r\n]+)/gm)) {
        for (const id of match[1]!.split(/[,\s]+/)) if (/^[\w.:-]+$/.test(id)) keepToolIds.add(id);
      }
    }
  }
  return { preserveFullContext, keepToolIds: [...keepToolIds] };
}
