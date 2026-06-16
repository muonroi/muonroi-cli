import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __artifactCacheSize,
  __resetArtifactCacheForTests,
  __setArtifactCacheDiskPathForTests,
  __setArtifactCacheMaxForTests,
  appendArtifactToDisk,
  findArtifactByQuery,
  findArtifactOnDisk,
  flushArtifactDiskWrites,
  getArtifact,
  recordArtifact,
} from "./artifact-cache.js";

// Redirect the disk spill to a temp file for EVERY test so recordArtifact never
// writes the real ~/.muonroi-cli/artifact-cache.jsonl.
const diskFile = path.join(os.tmpdir(), `muonroi-artifact-cache-test-${process.pid}.jsonl`);
beforeEach(() => __setArtifactCacheDiskPathForTests(diskFile));
afterEach(async () => {
  __resetArtifactCacheForTests();
  delete process.env.MUONROI_ARTIFACT_CACHE_DISK;
  await rm(diskFile, { force: true });
});

describe("artifact-cache (in-memory tier — durable rehydrate when EE is down)", () => {
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

describe("artifact-cache (disk spill — survives a process restart)", () => {
  it("rehydrates from disk after the in-memory tier is gone (simulated restart)", async () => {
    recordArtifact("call_disk", "read_file", "PERSISTED CONTENT");
    await flushArtifactDiskWrites();

    // Simulate a restart: in-memory tier cleared, but the disk file persists.
    __resetArtifactCacheForTests();
    __setArtifactCacheDiskPathForTests(diskFile);
    expect(findArtifactByQuery("tool-artifact id=call_disk")).toBeNull(); // memory gone
    const onDisk = await findArtifactOnDisk("tool-artifact id=call_disk");
    expect(onDisk?.content).toBe("PERSISTED CONTENT");
    expect(onDisk?.toolName).toBe("read_file");
  });

  it("newest record for an id wins on disk", async () => {
    await appendArtifactToDisk("dup", "t", "OLD");
    await appendArtifactToDisk("dup", "t", "NEW");
    expect((await findArtifactOnDisk("tool-artifact id=dup"))?.content).toBe("NEW");
  });

  it("respects MUONROI_ARTIFACT_CACHE_DISK=0 (no disk read)", async () => {
    await appendArtifactToDisk("x", "t", "C");
    process.env.MUONROI_ARTIFACT_CACHE_DISK = "0";
    expect(await findArtifactOnDisk("tool-artifact id=x")).toBeNull();
  });
});
