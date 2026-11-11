import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

const digest = (messages: readonly ModelMessage[]) =>
  createHash("sha256").update(JSON.stringify(messages)).digest("hex");
function lastUser(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i;
  return -1;
}
function copyMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  // Node structuredClone does not preserve URL objects. Media URL fields are
  // restored explicitly; typed arrays/ArrayBuffers retain native clone support.
  const urls: Array<{ message: number; part: number; field: string; href: string }> = [];
  const normalized = messages.map((message, i) =>
    typeof message.content === "string"
      ? message
      : {
          ...message,
          content: message.content.map((part, j) => {
            const value = { ...part } as Record<string, unknown>;
            for (const field of ["image", "data"])
              if (value[field] instanceof URL) {
                urls.push({ message: i, part: j, field, href: value[field].href });
                value[field] = value[field].href;
              }
            return value;
          }),
        },
  );
  const result = structuredClone(normalized) as ModelMessage[];
  for (const url of urls)
    (result[url.message]!.content as unknown as Record<string, unknown>[])[url.part]![url.field] = new URL(url.href);
  return result;
}
export interface HistoryReplay {
  messages: ModelMessage[];
  savedChars: number;
  /** Restore the original prefix if a later step requests preservation. */
  restore(messages: readonly ModelMessage[]): ModelMessage[];
}

/** One Agent-owned request view. Canonical history and stored evidence stay intact. */
export class RequestHistory {
  private saved?: { scope: string; sourceCount: number; sourceDigest: string; prefix: ModelMessage[] };

  clear(): void {
    this.saved = undefined;
  }

  remember(canonical: readonly ModelMessage[], compacted: readonly ModelMessage[], scope: string): void {
    // Only a completed compactor pass may call this. Exclude the current user
    // and all generated responses: their PIL/policy/stage context is transient.
    const sourceCount = lastUser(canonical),
      targetCount = lastUser(compacted);
    if (sourceCount <= 0 || targetCount <= 0) return;
    const source = canonical.slice(0, sourceCount),
      prefix = compacted.slice(0, targetCount);
    if (JSON.stringify(prefix).length >= JSON.stringify(source).length) return;
    this.saved = { scope, sourceCount, sourceDigest: digest(source), prefix: copyMessages(prefix) };
  }

  project(canonical: readonly ModelMessage[], scope: string): HistoryReplay {
    const saved = this.saved;
    if (
      !saved ||
      saved.scope !== scope ||
      canonical.length < saved.sourceCount ||
      digest(canonical.slice(0, saved.sourceCount)) !== saved.sourceDigest
    ) {
      this.clear();
      return { messages: [...canonical], savedChars: 0, restore: (messages) => [...messages] };
    }
    const original = canonical.slice(0, saved.sourceCount);
    const prefix = copyMessages(saved.prefix),
      prefixDigest = digest(prefix);
    return {
      messages: [...prefix, ...canonical.slice(saved.sourceCount)],
      savedChars: JSON.stringify(original).length - JSON.stringify(prefix).length,
      restore: (messages) => {
        // SDK prepareStep receives the original request plus new responses,
        // not the previous step's override. Refuse unknown provenance rather
        // than dropping messages to guess a restoration boundary.
        if (digest(messages.slice(0, prefix.length)) !== prefixDigest) {
          throw new Error("Cannot restore request history: projected prefix changed before preservation.");
        }
        return [...original, ...messages.slice(prefix.length)];
      },
    };
  }
}
