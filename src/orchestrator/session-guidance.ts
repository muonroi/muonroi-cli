import type { ModelMessage } from "ai";

const GUIDANCE_TAG = "[EE Session Guidance";

/** Replace guidance snapshots without changing unrelated history or persisted row identities. */
export function refreshSessionGuidance(messages: ModelMessage[], seqs: Array<number | null>, content?: string): void {
  const indexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "system" && typeof message.content === "string" && message.content.startsWith(GUIDANCE_TAG))
      indexes.push(i);
  }
  // A resumed process has not rehydrated the warning map: retain its latest snapshot.
  const current = content ?? messages[indexes.at(-1) ?? -1]?.content;
  if (typeof current !== "string") return;
  let keep: number | undefined;
  for (const i of indexes) if (messages[i]!.content === current) keep = i;
  for (const i of indexes.reverse()) {
    if (i === keep) continue;
    messages.splice(i, 1);
    seqs.splice(i, 1);
  }
  if (keep === undefined) {
    messages.push({ role: "system", content: current });
    seqs.push(null);
  }
}
