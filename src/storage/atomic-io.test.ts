import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicReadJSON, atomicWriteJSON, atomicWriteText, sweepStaleAtomicTemps } from "./atomic-io.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-io-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Build an errno error the way libuv does, so `err.code` is the real signal. */
function errno(code: string, syscall: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated, ${syscall}`);
  err.code = code;
  err.syscall = syscall;
  return err;
}

/**
 * Replace `fs.rename` with one that fails `failures` times before delegating to
 * the real implementation. `fs` here is the very `require("fs").promises` object
 * atomic-io.ts holds, so the spy is visible to the module under test.
 */
function stubRename(code: string, failures: number): { calls: () => number } {
  const real = fs.rename.bind(fs);
  let calls = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    calls++;
    if (calls <= failures) throw errno(code, "rename");
    return real(from, to);
  });
  return { calls: () => calls };
}

/** Every `.tmp` staging file left behind in `dir`. */
async function leftoverTemps(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
}

describe("atomicWriteJSON", () => {
  it("Test 1: writes file and removes .tmp on success", { retry: 2 }, async () => {
    const filePath = path.join(tmpDir, "foo.json");
    await atomicWriteJSON(filePath, { hello: 1 });

    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ hello: 1 });

    // .tmp must NOT exist after success
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
  });

  it("Test 2: throws on circular reference and does not leave .tmp", async () => {
    const filePath = path.join(tmpDir, "cyclic.json");
    // Write a pre-existing file to confirm it remains untouched on error
    await fs.writeFile(filePath, JSON.stringify({ safe: true }), "utf8");

    // Create a circular object
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(atomicWriteJSON(filePath, cyclic)).rejects.toThrow();

    // Pre-existing file must be untouched
    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ safe: true });

    // .tmp must NOT exist after failure
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    // Stronger: the serialize failure must not have created ANY staging file,
    // including the per-call `{name}.{pid}.{hex}.tmp` shape.
    expect(await leftoverTemps(tmpDir)).toEqual([]);
  });
});

// The defect this block pins: on 2026-09-26 the rename below threw EPERM twice
// in two different processes on two different target files (usage.json,
// config.json) while atomicWriteJSON had no retry at all — each one a LOST
// production write. atomicWriteText already carried the mitigation.
describe("atomicWriteJSON — transient rename contention", () => {
  it("Test 7: recovers the write after a transient EPERM on rename", async () => {
    const filePath = path.join(tmpDir, "usage.json");
    const rename = stubRename("EPERM", 1);

    await expect(atomicWriteJSON(filePath, { hello: "retried" })).resolves.toBeUndefined();

    expect(rename.calls()).toBe(2); // failed once, then succeeded
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ hello: "retried" });
    expect(await leftoverTemps(tmpDir)).toEqual([]);
  });

  it("Test 8: recovers the write after two transient EBUSY renames", async () => {
    const filePath = path.join(tmpDir, "config.json");
    const rename = stubRename("EBUSY", 2);

    await expect(atomicWriteJSON(filePath, { n: 2 })).resolves.toBeUndefined();

    expect(rename.calls()).toBe(3);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ n: 2 });
  });

  it("Test 9: a PERSISTENT EPERM still throws, with err.code intact", async () => {
    const filePath = path.join(tmpDir, "doomed.json");
    const rename = stubRename("EPERM", Number.POSITIVE_INFINITY);

    const err = await atomicWriteJSON(filePath, { a: 1 }).catch((e: NodeJS.ErrnoException) => e);

    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(rename.calls()).toBe(3); // exhausted the 3 attempts, no more
    expect(await leftoverTemps(tmpDir)).toEqual([]);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  // The property the fail-fast DENYLIST buys over a retry allowlist: the set of
  // codes the OS can report is open, so an unenumerated one must retry. EMFILE
  // (file-handle exhaustion) is real, plainly transient, and MORE likely under
  // exactly the load that produced both measured EPERMs — under an allowlist it
  // would silently lose the write.
  it("Test 10a: an UNENUMERATED transient code (EMFILE) is retried and the write lands", async () => {
    const filePath = path.join(tmpDir, "handles-exhausted.json");
    const rename = stubRename("EMFILE", 1);

    await expect(atomicWriteJSON(filePath, { landed: true })).resolves.toBeUndefined();

    expect(rename.calls()).toBe(2);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ landed: true });
  });

  it("Test 10: ENOSPC is NOT retried — it fails fast on the first attempt", async () => {
    const filePath = path.join(tmpDir, "full-disk.json");
    const rename = stubRename("ENOSPC", Number.POSITIVE_INFINITY);

    const err = await atomicWriteJSON(filePath, { a: 1 }).catch((e: NodeJS.ErrnoException) => e);

    expect((err as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(rename.calls()).toBe(1); // no backoff, no second attempt
  });

  it("Test 11: a HANGING rename is timed out and the retry lands the write", async () => {
    const filePath = path.join(tmpDir, "hung.json");
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      calls++;
      if (calls === 1) return new Promise<void>(() => {}); // never settles
      return real(from, to);
    });

    await expect(atomicWriteJSON(filePath, { recovered: true })).resolves.toBeUndefined();

    expect(calls).toBe(2);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ recovered: true });
  }, 25_000);

  it("Test 12: the ENOENT race loser still reports success", async () => {
    const filePath = path.join(tmpDir, "raced.json");
    // Another process already completed the atomic swap.
    await fs.writeFile(filePath, JSON.stringify({ winner: "other" }), "utf8");
    const rename = stubRename("ENOENT", Number.POSITIVE_INFINITY);

    await expect(atomicWriteJSON(filePath, { winner: "me" })).resolves.toBeUndefined();

    expect(rename.calls()).toBe(1); // ENOENT is not retried; the race check short-circuits
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ winner: "other" });
  });

  it("Test 13: a real ENOENT (no winner on disk) still throws", async () => {
    const filePath = path.join(tmpDir, "nobody.json");
    stubRename("ENOENT", Number.POSITIVE_INFINITY);

    const err = await atomicWriteJSON(filePath, { a: 1 }).catch((e: NodeJS.ErrnoException) => e);

    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("Test 14: a timeout names the JSON function, not its text sibling", async () => {
    const filePath = path.join(tmpDir, "labelled.json");
    vi.spyOn(fs, "rename").mockImplementation(() => new Promise<void>(() => {}));

    const err = await atomicWriteJSON(filePath, { a: 1 }).catch((e: Error) => e);

    expect((err as Error).message).toContain("atomicWriteJSON.rename timed out");
    expect((err as Error).message).not.toContain("atomicWriteText");
  }, 45_000);
});

describe("atomicWriteText", () => {
  it("Test 15: writes the content and leaves no staging file", async () => {
    const filePath = path.join(tmpDir, "notes.md");
    await atomicWriteText(filePath, "hello\nworld");

    expect(await fs.readFile(filePath, "utf8")).toBe("hello\nworld");
    expect(await leftoverTemps(tmpDir)).toEqual([]);
  });

  it("Test 16: keeps its existing transient-EPERM recovery", async () => {
    const filePath = path.join(tmpDir, "retried.md");
    const rename = stubRename("EPERM", 1);

    await atomicWriteText(filePath, "survived");

    expect(rename.calls()).toBe(2);
    expect(await fs.readFile(filePath, "utf8")).toBe("survived");
  });

  it("Test 17: a persistent failure still throws the last real error", async () => {
    const filePath = path.join(tmpDir, "doomed.md");
    stubRename("EBUSY", Number.POSITIVE_INFINITY);

    const err = await atomicWriteText(filePath, "x").catch((e: NodeJS.ErrnoException) => e);

    expect((err as NodeJS.ErrnoException).code).toBe("EBUSY");
  });
});

describe("atomicReadJSON", () => {
  it("Test 3: returns null for absent file", async () => {
    const filePath = path.join(tmpDir, "never-written.json");
    const result = await atomicReadJSON(filePath);
    expect(result).toBeNull();
  });

  it("Test 4: throws on corrupted (invalid JSON) file", async () => {
    const filePath = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(filePath, "{ this is not valid json }", "utf8");
    await expect(atomicReadJSON(filePath)).rejects.toThrow();
  });
});

describe("sweepStaleAtomicTemps", () => {
  it("Test 5: removes only matching .{pid}.{hex}.tmp older than cutoff", async () => {
    const oldStale = path.join(tmpDir, "state.json.12345.abcdef012345.tmp");
    const freshStale = path.join(tmpDir, "state.json.99999.fedcba543210.tmp");
    const unrelated = path.join(tmpDir, "notes.tmp");
    const real = path.join(tmpDir, "state.json");

    await fs.writeFile(oldStale, "{}");
    await fs.writeFile(freshStale, "{}");
    await fs.writeFile(unrelated, "junk");
    await fs.writeFile(real, "{}");

    // Backdate oldStale by 48h
    const old = Date.now() / 1000 - 48 * 3600;
    await fs.utimes(oldStale, old, old);

    const removed = await sweepStaleAtomicTemps(tmpDir, 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);

    await expect(fs.access(oldStale)).rejects.toThrow();
    await expect(fs.access(freshStale)).resolves.toBeUndefined();
    await expect(fs.access(unrelated)).resolves.toBeUndefined();
    await expect(fs.access(real)).resolves.toBeUndefined();
  });

  it("Test 6: returns 0 and does not throw when dir does not exist", async () => {
    const removed = await sweepStaleAtomicTemps(path.join(tmpDir, "does-not-exist"));
    expect(removed).toBe(0);
  });

  // If the tmp NAMING and the sweep REGEX ever disagree, a crashed writer leaks
  // its staging file forever. Take the name the real writer actually used and
  // hand it straight back to the sweeper.
  it("Test 19: sweeps the exact tmp name the shared write path produces", async () => {
    const filePath = path.join(tmpDir, "state.json");
    const realWrite = fs.writeFile.bind(fs);
    let usedTmp = "";
    vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, opts) => {
      usedTmp = String(target);
      return realWrite(target as string, data as string, opts as never);
    });

    await atomicWriteJSON(filePath, { a: 1 });
    vi.restoreAllMocks();

    expect(usedTmp).not.toBe("");
    // Recreate that same staging file as a crashed writer would have left it.
    await fs.writeFile(usedTmp, "{}", "utf8");
    const old = Date.now() / 1000 - 48 * 3600;
    await fs.utimes(usedTmp, old, old);

    expect(await sweepStaleAtomicTemps(tmpDir, 24 * 60 * 60 * 1000)).toBe(1);
    await expect(fs.access(usedTmp)).rejects.toThrow();
  });
});
