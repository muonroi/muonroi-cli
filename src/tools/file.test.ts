import { mkdir, mkdtemp, readFile, rm, writeFile as writeFsFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editFile, readFiles, writeFile } from "./file";

interface MockDiagnostic {
  message: string;
  severity: number;
  code?: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}
interface MockDiagnosticFile {
  filePath: string;
  serverId: string;
  diagnostics: MockDiagnostic[];
}

const syncFileWithLspMock = vi.fn<
  (
    cwd: string,
    filePath: string,
    content: string,
    save: boolean,
    waitForDiagnostics: boolean,
  ) => Promise<MockDiagnosticFile[]>
>(async (_cwd, filePath) => [
  {
    filePath,
    serverId: "typescript",
    diagnostics: [
      {
        message: "Type error",
        severity: 1,
        code: "2322",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    ],
  },
]);

// The LSP *runtime* is mocked (no language server in unit tests) but the
// diagnostic FORMATTER is the real one — the ack text is what the defect was
// about, so a stubbed formatter would assert nothing.
vi.mock("../lsp/runtime", async () => {
  const manager = await import("../lsp/manager");
  return {
    describeDiagnostics: manager.describeLspDiagnostics,
    syncFileWithLsp: (cwd: string, filePath: string, content: string, save: boolean, waitForDiagnostics: boolean) =>
      syncFileWithLspMock(cwd, filePath, content, save, waitForDiagnostics),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
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
    expect(result.output).toContain("1 LSP issue · 1 error");
    // The ack must NAME the diagnostic, not only count it, and with a
    // repo-relative path (the live trace carried absolute D:/sources/... noise).
    expect(result.output).toContain("demo.ts:1:1 error [2322] Type error");
    expect(result.output).not.toContain(cwd);
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

  it("the edit ack names the real diagnostics that wedged /ideal run muc2joffe506", async () => {
    // Measured: the blind-edit loop STARTED at this exact ack
    // ("Edited …/test_artifact_store_smoke.py (+3 -0)\n6 LSP issues · 6 errors",
    // interaction_logs 04:05:50, session bf39c59e4dd1). Line/code/message below
    // are verbatim from that file; columns are synthetic (the trace had lines only).
    const cwd = await createTempDir();
    const rel = "tests/test_artifact_store_smoke.py";
    const abs = path.join(cwd, "tests", "test_artifact_store_smoke.py");
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFsFile(abs, "import sys\nold\n", "utf8");

    const at = (line: number, character: number, message: string, code: string): MockDiagnostic => ({
      message,
      severity: 1,
      code,
      range: { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character: character + 3 } },
    });
    syncFileWithLspMock.mockResolvedValueOnce([
      {
        filePath: abs,
        serverId: "pyright",
        diagnostics: [
          at(159, 5, '"_pytest" is not defined', "reportUndefinedVariable"),
          at(
            173,
            9,
            'Argument of type "bytes" cannot be assigned to parameter "file_content" of type "BinaryIO" in function "save"',
            "reportArgumentType",
          ),
          at(356, 1, 'Import "sys" is not accessed', "reportUnusedImport"),
          at(357, 1, 'Import "importlib.util" is not accessed', "reportUnusedImport"),
        ],
      },
    ]);

    const result = await editFile(rel, "old", "new", cwd);

    expect(result.success).toBe(true);
    expect(result.output).toContain("4 LSP issues · 4 errors");
    expect(result.output).toContain(`${rel}:159:5 error [reportUndefinedVariable] "_pytest" is not defined`);
    expect(result.output).toContain(`${rel}:173:9 error [reportArgumentType] Argument of type "bytes" cannot be`);
    expect(result.output).toContain(`${rel}:356:1 error [reportUnusedImport] Import "sys" is not accessed`);
    expect(result.output).toContain(`${rel}:357:1 error [reportUnusedImport] Import "importlib.util" is not accessed`);
    // All four fit under the ack cap, so nothing is hidden.
    expect(result.output).not.toContain("not shown");
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
