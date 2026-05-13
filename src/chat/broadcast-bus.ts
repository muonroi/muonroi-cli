import type { BroadcastType, ChatClient } from "./types.js";
import { DISCORD_CONTENT_BUDGET } from "./verdict-constants.js";

export interface PublishArgs {
  client: ChatClient;
  channelId: string;
  type: BroadcastType;
  content: string;
}

function splitContent(content: string): string[] {
  if (content.length <= DISCORD_CONTENT_BUDGET) return [content];
  const parts: string[] = [];
  let remaining = content;
  while (remaining.length > DISCORD_CONTENT_BUDGET) {
    const budget = DISCORD_CONTENT_BUDGET - 16;
    let cutAt = remaining.lastIndexOf("\n\n", budget);
    if (cutAt < budget / 2) cutAt = remaining.lastIndexOf("\n", budget);
    if (cutAt < budget / 2) cutAt = remaining.lastIndexOf(" ", budget);
    if (cutAt < budget / 2) cutAt = budget;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\s+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts.map((p, i) => {
    let s = p;
    if (i > 0) s = "(continued) … " + s;
    if (i < parts.length - 1) s = s + " … (continued)";
    return s;
  });
}

export async function publish(args: PublishArgs): Promise<{ messageId: string } | null> {
  if (!args.content) {
    console.warn(`broadcast-bus: empty content for type=${args.type}; skipping`);
    return null;
  }
  const parts = splitContent(args.content);
  let lastId = "";
  for (const part of parts) {
    try {
      const res = await args.client.postMessage(args.channelId, part);
      lastId = res.id;
    } catch (e: any) {
      if (e?.status === 403 || e?.status === 404) {
        console.warn(`broadcast-bus: ${e.status} on postMessage; channel may be deleted or perms missing`);
        return null;
      }
      throw e;
    }
  }
  return { messageId: lastId };
}
