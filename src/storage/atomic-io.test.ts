import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { atomicWriteJSON, atomicReadJSON } from "./atomic-io.js";

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
    await expect(fs.access(filePath + ".tmp")).rejects.toThrow();
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
    await expect(fs.access(filePath + ".tmp")).rejects.toThrow();
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
