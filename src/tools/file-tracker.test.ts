import { readFile as fsRead, writeFile as fsWrite, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editFile, readFile, writeFile } from "./file";
import { FileTracker } from "./file-tracker";

vi.mock("../lsp/runtime", () => ({
  summarizeDiagnostics: () => "",
  syncFileWithLsp: async () => [],
}));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muonroi-tracker-"));
  tempDirs.push(dir);
  return dir;
}

describe("FileTracker — read-before-write guard", () => {
  it("rejects edit on an existing file that was not read first", async () => {
    const cwd = await createTempDir();
    await fsWrite(path.join(cwd, "demo.ts"), "const a = 1;\n", "utf8");
    const tracker = new FileTracker();

    const result = await editFile("demo.ts", "1", "2", cwd, tracker);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/must be read first/i);
  });

  it("rejects overwrite on an existing file that was not read first", async () => {
    const cwd = await createTempDir();
    await fsWrite(path.join(cwd, "demo.ts"), "old\n", "utf8");
    const tracker = new FileTracker();

    const result = await writeFile("demo.ts", "new\n", cwd, tracker);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/must be read first/i);
  });

  it("allows creating a new file without a prior read", async () => {
    const cwd = await createTempDir();
    const tracker = new FileTracker();

    const result = await writeFile("brand-new.ts", "fresh\n", cwd, tracker);

    expect(result.success).toBe(true);
    expect(await fsRead(path.join(cwd, "brand-new.ts"), "utf8")).toBe("fresh\n");
  });

  it("allows edit after a read of the same file", async () => {
    const cwd = await createTempDir();
    await fsWrite(path.join(cwd, "demo.ts"), "const a = 1;\n", "utf8");
    const tracker = new FileTracker();

    readFile("demo.ts", cwd, undefined, undefined, tracker);
    const result = await editFile("demo.ts", "1", "2", cwd, tracker);

    expect(result.success).toBe(true);
    expect(await fsRead(path.join(cwd, "demo.ts"), "utf8")).toBe("const a = 2;\n");
  });

  it("rejects edit when file changed on disk after the read (hash mismatch)", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "demo.ts");
    await fsWrite(filePath, "const a = 1;\n", "utf8");
    const tracker = new FileTracker();

    readFile("demo.ts", cwd, undefined, undefined, tracker);
    // Simulate external modification.
    await fsWrite(filePath, "const a = 99;\n", "utf8");

    const result = await editFile("demo.ts", "99", "100", cwd, tracker);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/changed on disk/i);
  });

  it("allows back-to-back edits without re-reading (write refreshes tracker)", async () => {
    const cwd = await createTempDir();
    await fsWrite(path.join(cwd, "demo.ts"), "1 2 3\n", "utf8");
    const tracker = new FileTracker();

    readFile("demo.ts", cwd, undefined, undefined, tracker);
    const r1 = await editFile("demo.ts", "1", "A", cwd, tracker);
    const r2 = await editFile("demo.ts", "2", "B", cwd, tracker);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(await fsRead(path.join(cwd, "demo.ts"), "utf8")).toBe("A B 3\n");
  });
});
