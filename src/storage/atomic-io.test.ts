import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicReadJSON, atomicWriteJSON, sweepStaleAtomicTemps } from "./atomic-io.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-io-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("atomicWriteJSON", () => {
  it("Test 1: writes file and removes .tmp on success", async () => {
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
});
