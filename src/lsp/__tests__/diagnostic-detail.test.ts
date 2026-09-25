/**
 * src/lsp/__tests__/diagnostic-detail.test.ts
 *
 * Pins `describeLspDiagnostics` — the formatter the BLOCKING commit gate and the
 * write/edit acks render, as opposed to `summarizeLspDiagnostics` which only
 * counts.
 *
 * Why it exists (measured, /ideal run `muc2joffe506`, session `bf39c59e4dd1` in
 * ~/.muonroi-cli/muonroi.db `interaction_logs`): four `tool_result/git_commit`
 * rows at 04:06:00 / 04:07:43 / 04:11:14 / 04:14:12 each said only
 * "6 LSP issues · 6 errors", so the model edited blind for ten minutes and made
 * it worse (6 → 6 → 6 → 7 at 04:15:35). The four diagnostics it was never shown
 * are the headline fixture below; every one is a one-line fix.
 *
 * Fixture provenance: filename, line, `code` and `message` are verbatim from
 * that run (obtained out-of-band via lsp_waitForDiagnostics, lspStatus "ok").
 * The `character` values are synthetic — the live trace recorded lines only —
 * and every severity is 1 because that repo's pyrightconfig.json promotes
 * reportUnusedImport to error.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeLspDiagnostics, LSP_DETAIL_MAX_ACK, LSP_DETAIL_MAX_GATE } from "../manager.js";
import type { LspDiagnostic, LspDiagnosticFile } from "../types.js";

// Stand-in for the live run's D:\sources\CompanyLibs\qa-platform. Built from
// tmpdir so the rendered relative path is identical on win32 and POSIX.
const CWD = resolve(tmpdir(), "qa-platform");
const SMOKE_REL = "tests/test_artifact_store_smoke.py";
const SMOKE_ABS = join(CWD, "tests", "test_artifact_store_smoke.py");

function diag(line: number, character: number, message: string, code?: string, severity = 1): LspDiagnostic {
  return {
    message,
    severity,
    code,
    source: "pyright",
    range: { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character: character + 4 } },
  };
}

/** The four real diagnostics the blocked run never saw. */
const REAL_FOUR: LspDiagnosticFile = {
  filePath: SMOKE_ABS,
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
};

describe("describeLspDiagnostics", () => {
  it("names every real diagnostic: relative file:line:col, severity, code, message", () => {
    const out = describeLspDiagnostics([REAL_FOUR], { cwd: CWD, max: LSP_DETAIL_MAX_GATE });
    expect(out).not.toBeNull();
    const text = out as string;

    // Header keeps the count indicator the gate used to emit on its own.
    expect(text.split("\n")[0]).toBe("4 LSP issues · 4 errors");

    // Each of the four is named with its own location, rule code and message.
    expect(text).toContain(`${SMOKE_REL}:159:5 error [reportUndefinedVariable] "_pytest" is not defined`);
    expect(text).toContain(
      `${SMOKE_REL}:173:9 error [reportArgumentType] Argument of type "bytes" cannot be assigned to parameter "file_content" of type "BinaryIO" in function "save"`,
    );
    expect(text).toContain(`${SMOKE_REL}:356:1 error [reportUnusedImport] Import "sys" is not accessed`);
    expect(text).toContain(`${SMOKE_REL}:357:1 error [reportUnusedImport] Import "importlib.util" is not accessed`);

    // Nothing truncated at 4 of a 20 cap.
    expect(text).not.toContain("not shown");
    expect(text.split("\n")).toHaveLength(5);
  });

  it("renders paths repo-relative with forward slashes, never absolute", () => {
    const text = describeLspDiagnostics([REAL_FOUR], { cwd: CWD, max: LSP_DETAIL_MAX_GATE }) as string;
    expect(text).not.toContain(SMOKE_ABS);
    expect(text).not.toContain("\\");
    expect(text).toContain(SMOKE_REL);
  });

  it("falls back to the given path when it is outside cwd (relative would be noise)", () => {
    const outside = resolve(tmpdir(), "elsewhere", "other.py");
    const text = describeLspDiagnostics(
      [{ filePath: outside, serverId: "pyright", diagnostics: [diag(1, 1, "boom", "reportGeneralTypeIssues")] }],
      { cwd: CWD, max: LSP_DETAIL_MAX_GATE },
    ) as string;
    expect(text).toContain("other.py:1:1 error [reportGeneralTypeIssues] boom");
    // Not silently rewritten into a ../../.. climb.
    expect(text).not.toContain("..");
  });

  it("caps output and says how many were omitted and how to see the rest", () => {
    const many: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: Array.from({ length: 200 }, (_, i) => diag(i + 1, 1, `err ${i}`, "reportGeneralTypeIssues")),
    };
    const text = describeLspDiagnostics([many], { cwd: CWD, max: LSP_DETAIL_MAX_GATE }) as string;
    const lines = text.split("\n");

    // 1 header + LSP_DETAIL_MAX_GATE diagnostics + 1 truncation note.
    expect(lines).toHaveLength(1 + LSP_DETAIL_MAX_GATE + 1);
    expect(lines[0]).toBe("200 LSP issues · 200 errors");
    const note = lines[lines.length - 1];
    // The note counts what was OMITTED; the header already carries the total.
    expect(note).toContain(`${200 - LSP_DETAIL_MAX_GATE} more not shown`);
    expect(note).toContain(`${200 - LSP_DETAIL_MAX_GATE} errors`);
    // Truncation must name the way out — a silent cut reproduces the defect.
    expect(note).toContain("wait_for_diagnostics");
  });

  it("sorts errors before warnings so a cap never hides an error behind a warning", () => {
    const mixed: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: [
        diag(10, 1, "just a warning", "reportUnusedVariable", 2),
        diag(20, 1, "an info", undefined, 3),
        diag(30, 1, "a real error", "reportUndefinedVariable", 1),
      ],
    };
    const lines = (describeLspDiagnostics([mixed], { cwd: CWD, max: 2 }) as string).split("\n");
    expect(lines[0]).toBe("3 LSP issues · 1 error · 1 warning · 1 info");
    expect(lines[1]).toContain("30:1 error [reportUndefinedVariable] a real error");
    expect(lines[2]).toContain("10:1 warning [reportUnusedVariable] just a warning");
    expect(lines[3]).toContain("1 more not shown (1 info)");
  });

  it("labels a warning as a warning so it cannot read as a blocking error", () => {
    const warnOnly: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: [diag(42, 3, "possibly unbound", "reportPossiblyUnbound", 2)],
    };
    const text = describeLspDiagnostics([warnOnly], { cwd: CWD, max: LSP_DETAIL_MAX_GATE }) as string;
    expect(text).toContain(`${SMOKE_REL}:42:3 warning [reportPossiblyUnbound] possibly unbound`);
    expect(text).not.toContain(" error ");
  });

  it("at the ack cap, every error still lands before any warning", () => {
    // The measured loop STARTED at an edit ack, so the ack's small cap must not
    // spend its budget on warnings while an error goes unmentioned.
    const noisy: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: [
        ...Array.from({ length: 20 }, (_, i) => diag(i + 1, 1, `warn ${i}`, "reportUnusedVariable", 2)),
        diag(500, 1, "the actual error", "reportUndefinedVariable", 1),
      ],
    };
    const lines = (describeLspDiagnostics([noisy], { cwd: CWD, max: LSP_DETAIL_MAX_ACK }) as string).split("\n");
    expect(lines[1]).toContain("500:1 error [reportUndefinedVariable] the actual error");
    expect(lines).toHaveLength(1 + LSP_DETAIL_MAX_ACK + 1);
    expect(lines[lines.length - 1]).toContain(`${21 - LSP_DETAIL_MAX_ACK} more not shown (16 warnings)`);
  });

  it("omits the [code] bracket when the server sent no code", () => {
    const noCode: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: [diag(7, 2, "unstructured complaint")],
    };
    const text = describeLspDiagnostics([noCode], { cwd: CWD, max: LSP_DETAIL_MAX_GATE }) as string;
    expect(text).toContain(`${SMOKE_REL}:7:2 error unstructured complaint`);
    expect(text).not.toContain("[");
  });

  it("keeps only the first line of a multi-line message and bounds its length", () => {
    const long = "x".repeat(400);
    const multi: LspDiagnosticFile = {
      filePath: SMOKE_ABS,
      serverId: "pyright",
      diagnostics: [diag(1, 1, `first line\nsecond line`), diag(2, 1, long)],
    };
    const lines = (describeLspDiagnostics([multi], { cwd: CWD, max: LSP_DETAIL_MAX_GATE }) as string).split("\n");
    expect(lines[1]).toContain("first line");
    expect(lines[1]).not.toContain("second line");
    expect(lines[2].length).toBeLessThan(300);
    expect(lines[2]).toContain("…");
  });

  it("returns null when there is nothing to report (same contract as the count summary)", () => {
    expect(describeLspDiagnostics([], { cwd: CWD, max: LSP_DETAIL_MAX_GATE })).toBeNull();
    expect(
      describeLspDiagnostics([{ filePath: SMOKE_ABS, serverId: "pyright", diagnostics: [] }], {
        cwd: CWD,
        max: LSP_DETAIL_MAX_GATE,
      }),
    ).toBeNull();
  });

  it("the ack cap is smaller than the blocking gate's cap", () => {
    // The gate fires once per commit and BLOCKS; an ack fires after every write.
    expect(LSP_DETAIL_MAX_ACK).toBeLessThan(LSP_DETAIL_MAX_GATE);
  });
});
