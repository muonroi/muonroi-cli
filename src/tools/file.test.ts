import { mkdtemp, readFile, rm, writeFile as writeFsFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editFile, readFiles, writeFile } from "./file";

const summarizeDiagnosticsMock = vi.fn<(diagnostics: unknown) => string>(() => "1 LSP issue · 1 error");
const syncFileWithLspMock = vi.fn<
  (
    cwd: string,
    filePath: string,
    content: string,
    save: boolean,
    waitForDiagnostics: boolean,
  ) => Promise<
    Array<{
      filePath: string;
      serverId: string;
      diagnostics: Array<{
        message: string;
        severity: number;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>;
    }>
  >
>(async () => [
  {
    filePath: "/tmp/demo.ts",
    serverId: "typescript",
    diagnostics: [
      {
        message: "Type error",
        severity: 1,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    ],
  },
]);

vi.mock("../lsp/runtime", () => ({
  summarizeDiagnostics: (diagnostics: unknown) => summarizeDiagnosticsMock(diagnostics),
  syncFileWithLsp: (cwd: string, filePath: string, content: string, save: boolean, waitForDiagnostics: boolean) =>
    syncFileWithLspMock(cwd, filePath, content, save, waitForDiagnostics),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  summarizeDiagnosticsMock.mockClear();
  syncFileWithLspMock.mockClear();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

describe("file tool LSP integration", () => {
  it("includes diagnostics metadata when writing a file", async () => {
    const cwd = await createTempDir();
    const result = await writeFile("demo.ts", "const answer = 42;\n", cwd);

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 LSP issue");
    expect(result.lspDiagnostics).toHaveLength(1);
    expect(syncFileWithLspMock).toHaveBeenCalledWith(
      cwd,
      path.join(cwd, "demo.ts"),
      "const answer = 42;\n",
      true,
      true,
    );
  });

  it("syncs edited file contents through the LSP runtime", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "demo.ts");
    await writeFsFile(filePath, "const answer = 41;\n", "utf8");

    const result = await editFile("demo.ts", "41", "42", cwd);
    const content = await readFile(filePath, "utf8");

    expect(result.success).toBe(true);
    expect(content).toContain("42");
    expect(syncFileWithLspMock).toHaveBeenCalledWith(cwd, filePath, "const answer = 42;\n", true, true);
  });
});

describe("editFile line-ending normalization", () => {
  it("matches a multi-line old_string (LF) against a CRLF file and preserves CRLF", async () => {
    // Live finding (storyflow_ui A/B 2026-06-06): both DeepSeek and Grok failed
    // 8-9/10 edit_file calls on CRLF-terminated Angular templates. The model
    // emits old_string with \n line breaks; the on-disk file uses \r\n, so an
    // exact substring match never finds a multi-line old_string. Only a
    // single-line edit (no newline) succeeded. The tool must normalize EOLs.
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "tpl.html");
    const crlf = '<div class="a">\r\n  <span></span>\r\n</div>\r\n';
    await writeFsFile(filePath, crlf, "utf8");

    // old_string + new_string use \n (what an LLM emits).
    const oldStr = '<div class="a">\n  <span></span>\n</div>';
    const newStr = '<div class="a">\n  <span>X</span>\n</div>';
    const result = await editFile("tpl.html", oldStr, newStr, cwd);
    const content = await readFile(filePath, "utf8");

    expect(result.success).toBe(true);
    expect(content).toContain("<span>X</span>");
    // CRLF must be preserved on the written lines (no silent LF conversion).
    expect(content).toContain('<div class="a">\r\n  <span>X</span>\r\n</div>\r\n');
    expect(content).not.toMatch(/[^\r]\n/); // no bare LF remains
  });

  it("still edits a plain LF file with an LF old_string (no regression)", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "tpl.ts");
    await writeFsFile(filePath, "const a = 1;\nconst b = 2;\n", "utf8");
    const result = await editFile("tpl.ts", "const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;", cwd);
    const content = await readFile(filePath, "utf8");
    expect(result.success).toBe(true);
    expect(content).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("still reports old_string not found when it is genuinely absent (CRLF file)", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "tpl.html");
    await writeFsFile(filePath, '<div class="a">\r\n  <span></span>\r\n</div>\r\n', "utf8");
    const result = await editFile("tpl.html", "<p>\n  nope\n</p>", "<p>yes</p>", cwd);
    expect(result.success).toBe(false);
    expect(result.output).toContain("old_string not found");
  });

  it("reports non-unique when the EOL-normalized old_string matches multiple times (CRLF file)", async () => {
    const cwd = await createTempDir();
    const filePath = path.join(cwd, "tpl.html");
    await writeFsFile(filePath, "<li>x</li>\r\n<li>x</li>\r\n", "utf8");
    const result = await editFile("tpl.html", "<li>x</li>", "<li>y</li>", cwd);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not unique");
  });
});

describe("readFiles (O1 multi-path batch read)", () => {
  it("reads multiple files in one call, each with its own header", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "a.ts"), "export const a = 1;\n", "utf8");
    await writeFsFile(path.join(cwd, "b.ts"), "export const b = 2;\n", "utf8");

    const result = readFiles(["a.ts", "b.ts"], cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("[a.ts: lines 1-");
    expect(result.output).toContain("export const a = 1;");
    expect(result.output).toContain("[b.ts: lines 1-");
    expect(result.output).toContain("export const b = 2;");
  });

  it("caps each file INDEPENDENTLY with an explicit marker — never silently drops a later file", async () => {
    const cwd = await createTempDir();
    // Big first file that would blow a whole-result cap and hide the 2nd file
    // under a naive head/tail truncation.
    await writeFsFile(path.join(cwd, "big.ts"), "x".repeat(50_000), "utf8");
    await writeFsFile(path.join(cwd, "small.ts"), "export const kept = true;\n", "utf8");

    const result = readFiles(["big.ts", "small.ts"], cwd, undefined, 4_000);
    expect(result.success).toBe(true);
    // big.ts is truncated with an explicit, self-describing marker (not silent).
    expect(result.output).toContain("chars of big.ts truncated in this batch read");
    // The SECOND file survives in full — the regression vector the cap must avoid.
    expect(result.output).toContain("export const kept = true;");
  });

  it("marks a missing file inline but still returns the other files (partial success)", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "present.ts"), "export const ok = 1;\n", "utf8");

    const result = readFiles(["present.ts", "ghost.ts"], cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("export const ok = 1;");
    expect(result.output).toContain("File not found: ghost.ts");
  });

  it("marks all read files on the tracker so a later edit is not blocked", async () => {
    const cwd = await createTempDir();
    await writeFsFile(path.join(cwd, "a.ts"), "const a = 1;\n", "utf8");
    await writeFsFile(path.join(cwd, "b.ts"), "const b = 2;\n", "utf8");
    const { FileTracker } = await import("./file-tracker.js");
    const tracker = new FileTracker();

    readFiles(["a.ts", "b.ts"], cwd, tracker);
    // Both files are now readable-before-write; editing b.ts must not be refused.
    const edit = await editFile("b.ts", "const b = 2;", "const b = 3;", cwd, tracker);
    expect(edit.success).toBe(true);
  });

  it("returns failure when no paths are provided", () => {
    const result = readFiles([], "/tmp");
    expect(result.success).toBe(false);
    expect(result.output).toContain("no paths provided");
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "muonroi-file-tools-"));
  tempDirs.push(dir);
  return dir;
}
