import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { RequestHistory } from "../request-history.js";

function fixture() {
  const source: ModelMessage[] = [
    { role: "user", content: "Historical request" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "read", input: {} }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "old",
          toolName: "read",
          output: { type: "text", value: "RAW_EVIDENCE ".repeat(500) },
        },
      ],
    },
    { role: "assistant", content: "Completed" },
    { role: "user", content: "Current question" },
  ];
  const compacted = structuredClone(source);
  compacted[2] = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "old",
        toolName: "read",
        output: { type: "text", value: "[saved tool result stub]" },
      },
    ],
  };
  compacted[4] = { role: "user", content: "Current question TRANSIENT_POLICY_TAIL" };
  const cache = new RequestHistory();
  cache.remember(source, compacted, "owner/model/policy");
  return { source, compacted, cache, scope: "owner/model/policy" };
}

describe("owner-scoped compacted request history", () => {
  it("reuses only the exact old prefix while preserving new turns and tool pairs", () => {
    const { source, cache, scope } = fixture();
    const live: ModelMessage[] = [
      ...source,
      { role: "assistant", content: "Final answer" },
      { role: "user", content: "New task" },
    ];
    const result = cache.project(live, scope).messages;
    expect(JSON.stringify(result)).not.toContain("RAW_EVIDENCE");
    expect(result.slice(4)).toEqual(live.slice(4));
    expect(JSON.stringify(result)).not.toContain("TRANSIENT_POLICY_TAIL");
    expect(JSON.stringify(source)).toContain("RAW_EVIDENCE");
    expect((result[1]!.content as any[])[0].toolCallId).toBe((result[2]!.content as any[])[0].toolCallId);
  });
  it.each([
    "content",
    "shortened",
    "scope",
  ])("invalidates a %s mismatch instead of reusing old evidence", (scenario) => {
    const { source, cache, scope } = fixture();
    const changed = structuredClone(source);
    if (scenario === "content") changed[0] = { role: "user", content: "HISTORICAL request" };
    if (scenario === "shortened") changed.splice(0, 3);
    const key = scenario === "scope" ? "other-owner/model/policy" : scope;
    expect(cache.project(changed, key).messages).toEqual(changed);
    expect(cache.project(source, scope).messages).toEqual(source); // invalidation is durable
  });
  it("restores the complete canonical prefix for preservation without losing new SDK responses", () => {
    const { source, cache, scope } = fixture();
    const replay = cache.project(source, scope);
    const delta: ModelMessage[] = [{ role: "assistant", content: "PRESERVE_FULL_CONTEXT" }];
    expect(replay.restore([...replay.messages, ...delta])).toEqual([...source, ...delta]);
  });
  it("refuses an unknown restoration boundary", () => {
    const { source, cache, scope } = fixture();
    const replay = cache.project(source, scope);
    expect(() => replay.restore([{ role: "user", content: "Different request" }])).toThrow("projected prefix changed");
  });
  it("does not let SDK mutations alter the stored view", () => {
    const { source, cache, scope } = fixture();
    const first = cache.project(source, scope);
    first.messages[0]!.content = "Mutated caller copy";
    expect(cache.project(source, scope).messages[0]!.content).toBe("Historical request");
  });
  it("preserves media URLs and binary content in a reused prefix", () => {
    const { source, compacted, cache, scope } = fixture();
    const media: ModelMessage = {
      role: "user",
      content: [
        { type: "image", image: new URL("https://example.test/image.png") },
        { type: "image", image: new Uint8Array([1, 2, 3]) },
        { type: "file", data: new URL("https://example.test/evidence.pdf"), mediaType: "application/pdf" },
      ],
    };
    source[0] = media;
    compacted[0] = media;
    cache.remember(source, compacted, scope);
    const parts = cache.project(source, scope).messages[0]!.content as any[];
    expect(parts[0].image).toBeInstanceOf(URL);
    expect(parts[0].image.href).toBe("https://example.test/image.png");
    expect(parts[1].image).toEqual(new Uint8Array([1, 2, 3]));
    expect(parts[2].data).toBeInstanceOf(URL);
  });
  it("clear disables reuse and does not retain a non-shrinking or empty projection", () => {
    const { source, cache, scope } = fixture();
    cache.clear();
    cache.remember(source, source, scope);
    expect(cache.project(source, scope).messages).toEqual(source);
    cache.remember([], [], scope);
    expect(cache.project(source, scope).messages).toEqual(source);
  });
});
