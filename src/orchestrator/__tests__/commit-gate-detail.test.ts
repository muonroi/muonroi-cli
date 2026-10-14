/**
 * src/orchestrator/__tests__/commit-gate-detail.test.ts
 *
 * Pins the BLOCKING side: `gateStagedPaths`'s `summary` must NAME the staged
 * file's errors, because that string is the whole of what `git_commit`'s refusal
 * (src/tools/registry.ts) and the bash `git-safety` block (`commitBlockedMessage`)
 * show the agent.
 *
 * Measured defect (/ideal run muc2joffe506, session bf39c59e4dd1 in
 * ~/.muonroi-cli/muonroi.db): four tool_result/git_commit rows over ten minutes
 * each carried only
 *   "No commit made (lsp-errors).\nStaged files have errors — fix them and call
 *    git_commit again:\n6 LSP issues · 6 errors"
 * so the model had nothing to act on; the count went 6 → 6 → 6 → 7.
 *
 * The gate self-disables under VITEST (isCommitGateEnabled), so these tests
 * clear that env for their duration and restore it afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDiagnosticFile } from "../../lsp/types.js";

const syncFileWithLspMock = vi.fn<(...args: unknown[]) => Promise<LspDiagnosticFile[]>>(async () => []);

// Real formatter, mocked language-server I/O — the text under test is the
// formatter's, so stubbing it would assert nothing.
vi.mock("../../lsp/runtime.js", async () => {
  const manager = await import("../../lsp/manager.js");
  return {
    describeDiagnostics: manager.describeLspDiagnostics,
    syncFileWithLsp: (...args: unknown[]) => syncFileWithLspMock(...args),
  };
});

const SMOKE_REL = join("tests", "test_artifact_store_smoke.py");
let cwd: string;
let savedVitest: string | undefined;
let savedNodeEnv: string | undefined;

function diag(line: number, character: number, message: string, code: string, severity = 1) {
  return {
    message,
    severity,
    code,
    source: "pyright",
    range: { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character: character + 3 } },
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "commit-gate-detail-"));
  mkdirSync(join(cwd, "tests"), { recursive: true });
  writeFileSync(join(cwd, SMOKE_REL), "import sys\n", "utf8");
  savedVitest = process.env.VITEST;
  savedNodeEnv = process.env.NODE_ENV;
  delete process.env.VITEST;
  if (process.env.NODE_ENV === "test") delete process.env.NODE_ENV;
  syncFileWithLspMock.mockReset();
});

afterEach(() => {
  if (savedVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitest;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("gateStagedPaths summary", () => {
  it("names each blocking error with file:line:col, severity, code and message", async () => {
    const abs = join(cwd, SMOKE_REL);
    syncFileWithLspMock.mockResolvedValue([
      {
        filePath: abs,
        serverId: "pyright",
        diagnostics: [
          diag(159, 5, '"_pytest" is not defined', "reportUndefinedVariable"),
          diag(
            173,
            9,
            'Argument of type "bytes" cannot be assigned to parameter "file_content" of type "BinaryIO" in function "save"',
            "reportArgumentType",
          ),
          diag(356, 1, 'Import "sys" is not accessed', "reportUnusedImport"),
          diag(357, 1, 'Import "importlib.util" is not accessed', "reportUnusedImport"),
        ],
      },
    ]);

    const { gateStagedPaths } = await import("../auto-commit.js");
    const gate = await gateStagedPaths(cwd, [SMOKE_REL]);

    expect(gate.ok).toBe(false);
    const summary = gate.summary as string;
    // The count header the gate used to emit ALONE is kept as line 1.
    expect(summary.split("\n")[0]).toBe("4 LSP issues · 4 errors");
    // …and every diagnostic is now named, repo-relative.
    expect(summary).toContain('tests/test_artifact_store_smoke.py:159:5 error [reportUndefinedVariable] "_pytest" is');
    expect(summary).toContain("tests/test_artifact_store_smoke.py:173:9 error [reportArgumentType] Argument of type");
    expect(summary).toContain(
      'tests/test_artifact_store_smoke.py:356:1 error [reportUnusedImport] Import "sys" is not accessed',
    );
    expect(summary).toContain(
      'tests/test_artifact_store_smoke.py:357:1 error [reportUnusedImport] Import "importlib.util" is not accessed',
    );
    expect(summary).not.toContain(abs);
  });

  it("bounds a pathological file and says how many it omitted and where to look", async () => {
    syncFileWithLspMock.mockResolvedValue([
      {
        filePath: join(cwd, SMOKE_REL),
        serverId: "pyright",
        diagnostics: Array.from({ length: 200 }, (_, i) => diag(i + 1, 1, `boom ${i}`, "reportGeneralTypeIssues")),
      },
    ]);

    const { LSP_DETAIL_MAX_GATE } = await import("../../lsp/manager.js");
    const { gateStagedPaths } = await import("../auto-commit.js");
    const gate = await gateStagedPaths(cwd, [SMOKE_REL]);

    expect(gate.ok).toBe(false);
    const lines = (gate.summary as string).split("\n");
    expect(lines).toHaveLength(1 + LSP_DETAIL_MAX_GATE + 1);
    expect(lines[lines.length - 1]).toContain(`${200 - LSP_DETAIL_MAX_GATE} more not shown`);
    expect(lines[lines.length - 1]).toContain("wait_for_diagnostics");
  });

  it("never renders a warning as blocking: warnings do not reach the gate summary at all", async () => {
    syncFileWithLspMock.mockResolvedValue([
      {
        filePath: join(cwd, SMOKE_REL),
        serverId: "pyright",
        diagnostics: [
          diag(10, 1, "just a warning", "reportUnusedVariable", 2),
          diag(20, 1, "a real error", "reportUndefinedVariable", 1),
        ],
      },
    ]);

    const { gateStagedPaths } = await import("../auto-commit.js");
    const gate = await gateStagedPaths(cwd, [SMOKE_REL]);

    expect(gate.ok).toBe(false);
    const summary = gate.summary as string;
    expect(summary).toContain("20:1 error [reportUndefinedVariable] a real error");
    // blockingErrorsForFile filters to severity 1, so the warning is absent —
    // it cannot be mistaken for something that must be fixed to commit.
    expect(summary).not.toContain("just a warning");
    expect(summary).toBe(
      "1 LSP issue · 1 error\n  tests/test_artifact_store_smoke.py:20:1 error [reportUndefinedVariable] a real error",
    );
  });

  it("stays silent (ok) when the staged file is clean", async () => {
    syncFileWithLspMock.mockResolvedValue([]);
    const { gateStagedPaths } = await import("../auto-commit.js");
    await expect(gateStagedPaths(cwd, [SMOKE_REL])).resolves.toEqual({ ok: true });
  });
});
