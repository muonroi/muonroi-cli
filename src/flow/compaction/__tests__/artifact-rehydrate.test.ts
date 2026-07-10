import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetArtifactCacheForTests, findArtifactByQuery, getArtifact } from "../../../ee/artifact-cache.js";
import { recordToolArtifactsForRehydrate } from "../index.js";

// Disk write is disabled so the test never touches the real
// ~/.muonroi-cli/artifact-cache.jsonl; we only assert the in-memory tier that
// ee_query reads first.
beforeEach(() => {
  process.env.MUONROI_ARTIFACT_CACHE_DISK = "0";
  __resetArtifactCacheForTests();
});
afterEach(() => {
  delete process.env.MUONROI_ARTIFACT_CACHE_DISK;
  __resetArtifactCacheForTests();
});

describe("recordToolArtifactsForRehydrate (deliberate-compact anti-mù parity)", () => {
  it("records each tool result so ee_query can rehydrate it after /compact", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "read the auth file" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: {} } as never],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: "FULL CONTENT of src/auth.ts",
          } as never,
        ],
      },
    ];

    const recorded = recordToolArtifactsForRehydrate(messages, "/tmp/project");
    expect(recorded).toBe(1);
    // The full content is now rehydratable by tool call id.
    expect(getArtifact("call_1")?.content).toBe("FULL CONTENT of src/auth.ts");
    expect(findArtifactByQuery("tool-artifact id=call_1")?.content).toBe("FULL CONTENT of src/auth.ts");
  });

  it("stringifies non-string tool payloads and skips results without a call id", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_json", toolName: "grep", output: { hits: 3 } } as never,
          { type: "tool-result", toolCallId: "", toolName: "noop", output: "dropped" } as never,
        ],
      },
    ];
    const recorded = recordToolArtifactsForRehydrate(messages, "/tmp/project");
    expect(recorded).toBe(1);
    expect(getArtifact("call_json")?.content).toContain('"hits":3');
  });

  it("ignores non-tool messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(recordToolArtifactsForRehydrate(messages, "/tmp/project")).toBe(0);
  });
});
