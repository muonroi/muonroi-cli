import { createHash } from "node:crypto";

/** Display-only projection. The model, transcript and exports keep the raw result. */
export function delegationNotificationForDisplay(content: string): string {
  const header = /^\[Worker messages jobId=([\w-]+) status=(running|complete|error|cancelled)\]\n\n/.exec(content);
  const footer =
    "\n\nReply to a question with delegation_send({id: jobId, message: answer, replyTo: messageId}). Messages do not verify or accept work.";
  if (!header || !content.endsWith(footer)) return content;
  const body = content
    .slice(header[0].length, -footer.length)
    .replace(
      /^\[worker-message:[^\]]+\] messageId=[^\n]+ kind=(progress|question)[^\n]*\n/gm,
      (_line, kind: string) => `${kind === "question" ? "Question" : "Progress"}\n`,
    );
  return `Worker ${header[1]} (${header[2]})\n\n${body}`;
}

export function delegationResultForDisplay(content: string): string {
  const boundary = content.indexOf("\n\n");
  if (boundary < 0) return content;
  const header = content.slice(0, boundary).split("\n");
  if (
    !/^jobId=[\w-]+$/.test(header[0] ?? "") ||
    !/^resultVersion=[\w-]+$/.test(header[1] ?? "") ||
    !header[2]?.startsWith("Saved result: ")
  )
    return content;
  const body = content.slice(boundary + 2);
  const reference = header.map((line) => /^Host review evidence sha256=([a-f0-9]{64})$/.exec(line)).find(Boolean);
  if (!reference) return body;
  const marker =
    "\n## Host review evidence\nHost-collected native tool results. Static inspection does not establish executed tests. Source snapshot is not an OS sandbox.\n";
  const start = body.lastIndexOf(marker);
  if (start < 0) return body;
  const evidence = body.slice(start + marker.length).trimEnd();
  // Only the host's exact trailing evidence block is hidden. Worker lookalikes
  // and malformed/tampered output stay visible; raw storage/export is untouched.
  return createHash("sha256").update(evidence).digest("hex") === reference[1] ? body.slice(0, start).trimEnd() : body;
}

export function parseDelegationList(
  content: string,
): { id: string; status: string; label: string; delivery?: string; acknowledgement?: string }[] {
  const items: { id: string; status: string; label: string; delivery?: string; acknowledgement?: string }[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(
      /^\s*-\s+`([^`]+)`\s+\[(?:execution=)?(running|complete|error|cancelled)](?:\s+\[(?:delivery=)?(pending|delivered|acknowledged)])?(?:\s+\[ack=(pending|acknowledged|not_ready)])?\s+(.*)$/,
    );
    if (match)
      items.push({
        id: match[1]!,
        status: match[2]!,
        label: match[5]!.trim(),
        ...(match[3] ? { delivery: match[3] === "acknowledged" ? "delivered" : match[3] } : {}),
        ...(match[4] || match[3] === "acknowledged" ? { acknowledgement: match[4] ?? "acknowledged" } : {}),
      });
  }
  return items;
}
