import { afterEach, describe, expect, it } from "vitest";
import {
  __artifactCacheSize,
  __resetArtifactCacheForTests,
  __setArtifactCacheMaxForTests,
  findArtifactByQuery,
  getArtifact,
  recordArtifact,
} from "./artifact-cache.js";

describe("artifact-cache (anti-mù durability — local rehydrate fallback)", () => {
  afterEach(() => __resetArtifactCacheForTests());

  it("records and retrieves an elided output by toolCallId", () => {
    recordArtifact("call_7", "read_file", "FULL CONTENT of src/auth.ts");
    expect(getArtifact("call_7")).toEqual({ toolName: "read_file", content: "FULL CONTENT of src/auth.ts" });
    expect(getArtifact("missing")).toBeNull();
  });

  it("no-ops on empty id or empty content", () => {
    recordArtifact("", "read_file", "x");
    recordArtifact("call_x", "read_file", "");
    expect(__artifactCacheSize()).toBe(0);
  });

  it("findArtifactByQuery extracts the id from the contract query strings", () => {
    recordArtifact("abc123", "grep", "GREP HITS");
    expect(findArtifactByQuery("tool-artifact id=abc123")?.content).toBe("GREP HITS");
    expect(findArtifactByQuery("full tool result id=abc123")?.toolCallId).toBe("abc123");
    expect(findArtifactByQuery("tool-artifact  ID = abc123")?.content).toBe("GREP HITS"); // spacing/case
    expect(findArtifactByQuery("tool-artifact id=nope")).toBeNull(); // not cached
    expect(findArtifactByQuery("no id here")).toBeNull(); // no id=
  });

  it("evicts the oldest entries past the LRU cap; re-recording refreshes recency", () => {
    __setArtifactCacheMaxForTests(2);
    recordArtifact("a", "t", "A");
    recordArtifact("b", "t", "B");
    recordArtifact("a", "t", "A2"); // touch 'a' → now 'b' is oldest
    recordArtifact("c", "t", "C"); // evicts 'b'
    expect(getArtifact("a")?.content).toBe("A2");
    expect(getArtifact("c")?.content).toBe("C");
    expect(getArtifact("b")).toBeNull();
    expect(__artifactCacheSize()).toBe(2);
  });
});
