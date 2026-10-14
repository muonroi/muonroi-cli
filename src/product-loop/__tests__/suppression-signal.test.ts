/**
 * Slice H — a diagnostic silenced is not a diagnostic fixed.
 *
 * The headline fixture is the REAL pair of added lines from the live `/ideal`
 * run whose commit was titled `fix(sprint1): resolve 3 LSP errors in
 * artifact-store smoke test` and resolved 3 of its 4 diagnostics by adding a
 * `# type: ignore` rather than by changing the code.
 */

import { describe, expect, it } from "vitest";
import { formatSuppressionNote, SUPPRESSION_DETAIL_MAX, scanDiffForSuppressions } from "../suppression-signal.js";

/**
 * The measured case, verbatim. Hunk starts at new-file line 10, so the context
 * line is 10 and the two added lines are 11 and 12.
 */
const MEASURED_DIFF = [
  "diff --git a/backend/tests/test_artifact_store_smoke.py b/backend/tests/test_artifact_store_smoke.py",
  "index 1111111..2222222 100644",
  "--- a/backend/tests/test_artifact_store_smoke.py",
  "+++ b/backend/tests/test_artifact_store_smoke.py",
  "@@ -10,1 +10,3 @@ def test_save_accepts_bytes():",
  " import json",
  "+        import sys  # type: ignore[reportUnusedImport]",
  "+            file_content=PNG_MAGIC,  # type: ignore[arg-type]  # raw bytes accepted by save()",
  "",
].join("\n");

describe("scanDiffForSuppressions — the measured case", () => {
  it("reports both added `# type: ignore` directives with file, line and silenced rule", () => {
    const scan = scanDiffForSuppressions(MEASURED_DIFF);
    expect(scan.total).toBe(2);
    expect(scan.findings).toEqual([
      {
        file: "backend/tests/test_artifact_store_smoke.py",
        line: 11,
        directive: "# type: ignore",
        rules: ["reportUnusedImport"],
        text: "import sys  # type: ignore[reportUnusedImport]",
      },
      {
        file: "backend/tests/test_artifact_store_smoke.py",
        line: 12,
        directive: "# type: ignore",
        rules: ["arg-type"],
        text: "file_content=PNG_MAGIC,  # type: ignore[arg-type]  # raw bytes accepted by save()",
      },
    ]);
  });

  it("renders a note that names each file:line, the directive and the rule", () => {
    const note = formatSuppressionNote(scanDiffForSuppressions(MEASURED_DIFF));
    expect(note).not.toBeNull();
    expect(note).toContain("2 suppression directive(s)");
    expect(note).toContain(
      "backend/tests/test_artifact_store_smoke.py:11 — `# type: ignore` silences reportUnusedImport",
    );
    expect(note).toContain("backend/tests/test_artifact_store_smoke.py:12 — `# type: ignore` silences arg-type");
  });
});

describe("scanDiffForSuppressions — only the sprint's own ADDED lines count", () => {
  it("ignores a suppression that is context (already in the file) or removed", () => {
    const diff = [
      "diff --git a/app/models.py b/app/models.py",
      "--- a/app/models.py",
      "+++ b/app/models.py",
      "@@ -1,3 +1,3 @@",
      " import os  # type: ignore[reportUnusedImport]",
      "-import re  # noqa: F401",
      "+import re",
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.total).toBe(0);
    expect(scan.findings).toEqual([]);
    expect(formatSuppressionNote(scan)).toBeNull();
  });

  it("attributes each finding to the file its own `+++` header names", () => {
    const diff = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -0,0 +1,1 @@",
      "+import os  # noqa",
      "diff --git a/b.go b/b.go",
      "--- a/b.go",
      "+++ b/b.go",
      "@@ -4,0 +5,1 @@",
      "+//nolint:errcheck,gosec",
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.findings).toEqual([
      { file: "a.py", line: 1, directive: "# noqa", rules: [], text: "import os  # noqa" },
      { file: "b.go", line: 5, directive: "//nolint", rules: ["errcheck", "gosec"], text: "//nolint:errcheck,gosec" },
    ]);
  });

  it("skips a deleted file's `+++ /dev/null` header", () => {
    const diff = [
      "diff --git a/gone.py b/gone.py",
      "--- a/gone.py",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-import os  # noqa",
      "",
    ].join("\n");
    expect(scanDiffForSuppressions(diff).total).toBe(0);
  });
});

describe("scanDiffForSuppressions — a bare directive names no rule", () => {
  it("distinguishes `# type: ignore` from `# type: ignore[arg-type]`", () => {
    const diff = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -1,0 +1,1 @@",
      "+x = f(y)  # type: ignore",
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.findings[0]?.rules).toEqual([]);
    expect(formatSuppressionNote(scan)).toContain(
      "`# type: ignore` silences EVERY diagnostic on the line (no rule named)",
    );
  });
});

describe("scanDiffForSuppressions — two directives on one line are two findings", () => {
  it("reports both `# noqa: F401` and `# type: ignore[import]` from the measured commit's own line", () => {
    // Verbatim added line from qa-platform 4d73157 (backend/shared/__init__.py).
    const diff = [
      "diff --git a/backend/shared/__init__.py b/backend/shared/__init__.py",
      "--- a/backend/shared/__init__.py",
      "+++ b/backend/shared/__init__.py",
      "@@ -7,0 +7,1 @@",
      "+from shared.contracts.artifact_store import (  # noqa: F401  # type: ignore[import]",
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.total).toBe(2);
    expect(scan.findings.map((f) => [f.line, f.directive, f.rules])).toEqual([
      [7, "# noqa", ["F401"]],
      [7, "# type: ignore", ["import"]],
    ]);
  });

  it("counts `eslint-disable-next-line` once, not also as the bare `eslint-disable` inside it", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +1,1 @@",
      "+// eslint-disable-next-line no-unused-vars",
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.total).toBe(1);
    expect(scan.findings[0]?.directive).toBe("// eslint-disable-next-line");
  });
});

describe("scanDiffForSuppressions — a mention is not a suppression", () => {
  it("does not fire on a directive inside a Python string literal", () => {
    const diff = [
      "diff --git a/t.py b/t.py",
      "--- a/t.py",
      "+++ b/t.py",
      "@@ -1,0 +1,2 @@",
      '+    assert line == "# type: ignore[reportUnusedImport]"',
      "+    BARE = '# noqa'",
      "",
    ].join("\n");
    expect(scanDiffForSuppressions(diff).total).toBe(0);
  });

  it("does not fire on a directive quoted in documentation", () => {
    const diff = [
      "diff --git a/docs/style.md b/docs/style.md",
      "--- a/docs/style.md",
      "+++ b/docs/style.md",
      "@@ -1,0 +1,1 @@",
      "+Never add `# type: ignore[reportUnusedImport]` to silence an unused import.",
      "",
    ].join("\n");
    expect(scanDiffForSuppressions(diff).total).toBe(0);
  });

  it("does not fire on a directive inside a TypeScript regex literal or string", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +1,2 @@",
      "+const RE = /\\/\\/ @ts-ignore/;",
      '+const LABEL = "// @ts-ignore";',
      "",
    ].join("\n");
    expect(scanDiffForSuppressions(diff).total).toBe(0);
  });
});

describe("scanDiffForSuppressions — the directives this ecosystem actually uses", () => {
  const cases: Array<{ file: string; added: string; directive: string; rules: string[] }> = [
    {
      file: "a.py",
      added: "x = 1  # pyright: ignore[reportGeneralTypeIssues]",
      directive: "# pyright: ignore",
      rules: ["reportGeneralTypeIssues"],
    },
    { file: "a.py", added: "import os  # noqa: F401,E501", directive: "# noqa", rules: ["F401", "E501"] },
    { file: "a.ts", added: "// @ts-ignore", directive: "// @ts-ignore", rules: [] },
    { file: "a.tsx", added: "// @ts-expect-error legacy shape", directive: "// @ts-expect-error", rules: [] },
    {
      file: "a.ts",
      added: "// biome-ignore lint/suspicious/noExplicitAny: shim",
      directive: "// biome-ignore",
      rules: ["lint/suspicious/noExplicitAny"],
    },
    {
      file: "a.js",
      added: "// eslint-disable-next-line no-unused-vars, camelcase",
      directive: "// eslint-disable-next-line",
      rules: ["no-unused-vars", "camelcase"],
    },
    { file: "a.js", added: "/* eslint-disable */", directive: "// eslint-disable", rules: [] },
    {
      file: "A.cs",
      added: "#pragma warning disable CS0168, CS0219",
      directive: "#pragma warning disable",
      rules: ["CS0168", "CS0219"],
    },
    {
      file: "A.cs",
      added: '[SuppressMessage("Design", "CA1031:DoNotCatchGeneralExceptionTypes")]',
      directive: "[SuppressMessage]",
      rules: ["Design", "CA1031:DoNotCatchGeneralExceptionTypes"],
    },
    {
      file: "A.java",
      added: '@SuppressWarnings({"unchecked", "rawtypes"})',
      directive: "@SuppressWarnings",
      rules: ["unchecked", "rawtypes"],
    },
    { file: "a.go", added: "//nolint", directive: "//nolint", rules: [] },
    {
      file: "a.rs",
      added: "#[allow(dead_code, unused_imports)]",
      directive: "#[allow]",
      rules: ["dead_code", "unused_imports"],
    },
  ];

  for (const c of cases) {
    it(`detects ${c.directive} in ${c.file}`, () => {
      const diff = [
        `diff --git a/${c.file} b/${c.file}`,
        `--- a/${c.file}`,
        `+++ b/${c.file}`,
        "@@ -1,0 +1,1 @@",
        `+${c.added}`,
        "",
      ].join("\n");
      const scan = scanDiffForSuppressions(diff);
      expect(scan.total, `expected a hit for ${c.added}`).toBe(1);
      expect(scan.findings[0]?.directive).toBe(c.directive);
      expect(scan.findings[0]?.rules).toEqual(c.rules);
    });
  }
});

describe("scanDiffForSuppressions — bounded output", () => {
  it(`caps findings at SUPPRESSION_DETAIL_MAX and keeps the true total`, () => {
    const added = Array.from({ length: SUPPRESSION_DETAIL_MAX + 7 }, () => "+x = 1  # type: ignore");
    const diff = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      `@@ -1,0 +1,${added.length} @@`,
      ...added,
      "",
    ].join("\n");
    const scan = scanDiffForSuppressions(diff);
    expect(scan.total).toBe(SUPPRESSION_DETAIL_MAX + 7);
    expect(scan.findings).toHaveLength(SUPPRESSION_DETAIL_MAX);
    expect(formatSuppressionNote(scan)).toContain(`(+7 more not shown)`);
  });

  it("bounds a pathologically long added line", () => {
    const long = `x = 1  # type: ignore[arg-type]  # ${"y".repeat(500)}`;
    const diff = ["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -1,0 +1,1 @@", `+${long}`, ""].join("\n");
    const text = scanDiffForSuppressions(diff).findings[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(201);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("formatSuppressionNote", () => {
  it("returns null for a scan that found nothing, so nothing is narrated", () => {
    expect(formatSuppressionNote({ findings: [], total: 0 })).toBeNull();
  });
});

// ── Wiring: the reviewer's own diff → the verdict → sprints/<n>-adherence.json ──

describe("runPlanAdherenceReview + buildAdherenceRecord carry the scan", () => {
  it("reports the measured suppressions without changing the verdict, and persists them off `deviations`", async () => {
    const { runPlanAdherenceReview } = await import("../plan-adherence-review.js");
    const { buildAdherenceRecord } = await import("../sprint-runner.js");

    const chunks: string[] = [];
    const gen = runPlanAdherenceReview({
      sprintN: 1,
      planSynthesis: "plan with file_edits",
      cwd: "/tmp",
      reviewModelId: "leader-pro",
      fixModelId: "cheap-flash",
      runIsolatedTask: async () => ({ success: true, output: '{"adherent": true, "deviations": []}' }),
      diffProvider: () => MEASURED_DIFF,
    });
    let next = await gen.next();
    while (!next.done) {
      const c = next.value as { type: string; content?: string };
      if (c.type === "content" && c.content) chunks.push(c.content);
      next = await gen.next();
    }
    const verdict = next.value;

    // The reviewer approved; the suppressions must not have changed that.
    expect(verdict.adherent).toBe(true);
    expect(verdict.stopReason).toBe("approved");
    expect(verdict.deviations).toEqual([]);

    expect(verdict.suppressions?.total).toBe(2);
    expect(verdict.suppressions?.findings.map((f) => `${f.file}:${f.line}`)).toEqual([
      "backend/tests/test_artifact_store_smoke.py:11",
      "backend/tests/test_artifact_store_smoke.py:12",
    ]);

    // It is narrated on the SAME transcript channel the deviations use.
    expect(chunks.join("")).toContain("2 suppression directive(s)");

    const record = buildAdherenceRecord({
      sprintN: 1,
      runId: "run-h",
      reviewModelId: "leader-pro",
      fixModelId: "cheap-flash",
      verdict,
      startedAt: new Date(0).toISOString(),
    });
    expect(record.suppressions?.total).toBe(2);
    // Its own field — never smuggled into the deviation channel.
    expect(record.residualDeviations).toEqual([]);
    expect(record.rounds.flatMap((r) => r.deviations)).toEqual([]);
    expect(record.finalVerdict).toBe(true);
  });

  it("omits `suppressions` entirely when no diff was scanned (absence is not `none found`)", async () => {
    const { runPlanAdherenceReview } = await import("../plan-adherence-review.js");
    const { buildAdherenceRecord } = await import("../sprint-runner.js");
    const gen = runPlanAdherenceReview({
      sprintN: 2,
      planSynthesis: "plan",
      cwd: "/tmp",
      reviewModelId: "leader-pro",
      fixModelId: "cheap-flash",
      runIsolatedTask: async () => ({ success: true, output: "{}" }),
      diffProvider: () => "",
    });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const verdict = next.value;
    expect(verdict.stopReason).toBe("no_diff");
    expect(verdict.suppressions).toBeUndefined();
    const record = buildAdherenceRecord({
      sprintN: 2,
      runId: "run-h",
      reviewModelId: "leader-pro",
      fixModelId: "cheap-flash",
      verdict,
      startedAt: new Date(0).toISOString(),
    });
    expect("suppressions" in record).toBe(false);
  });
});
