/**
 * spec-layout-check.test.ts — S7 unit cover for the pure `checkSpecLayout`
 * function. No filesystem, no LLM: every case constructs a `LayoutConvention`
 * fixture directly (same shape `layout-convention.ts` derives) and asserts
 * the deterministic verdict.
 */
import { describe, expect, it } from "vitest";
import type { LayoutConvention } from "../layout-convention.js";
import { checkSpecLayout, formatSpecLayoutCorrection } from "../spec-layout-check.js";

/** Synthetic fixture shaped like the tcis-libraries convention, neutral naming. */
const DOTNET_STYLE_CONVENTION: LayoutConvention = {
  projectsDir: "src/src",
  projectsCount: 50,
  projectManifestName: "<Name>.csproj",
  testsDir: "src/tests",
  testsCount: 48,
  testSuffix: ".Tests",
  solutionFile: "src/Acme.sln",
  totalExamples: 98,
};

describe("checkSpecLayout", () => {
  it("flags a folderStructure path clearly under a different root than the observed convention", () => {
    const result = checkSpecLayout("src/Acme.Widgets", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("mismatch");
    expect(result.findings).toEqual([{ path: "src/Acme.Widgets", expectedRoot: "src/src", kind: "project" }]);
  });

  it("flags a test path clearly under a different root than the observed test convention", () => {
    const result = checkSpecLayout("src/Acme.Widgets.Tests", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("mismatch");
    expect(result.findings).toEqual([{ path: "src/Acme.Widgets.Tests", expectedRoot: "src/tests", kind: "test" }]);
  });

  it("passes when the folderStructure path sits under the observed project root", () => {
    const result = checkSpecLayout("src/src/Acme.Widgets", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("passes when the folderStructure path sits under the observed test root", () => {
    const result = checkSpecLayout("src/tests/Acme.Widgets.Tests", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("passes when both a project and a test path are given and both match", () => {
    const result = checkSpecLayout(
      "src/src/Acme.Widgets and its tests at src/tests/Acme.Widgets.Tests",
      DOTNET_STYLE_CONVENTION,
    );
    expect(result.status).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("reports every mismatching path, not just the first", () => {
    const result = checkSpecLayout("src/Acme.Widgets; src/Acme.Widgets.Tests", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("mismatch");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.kind).sort()).toEqual(["project", "test"]);
  });

  it("is unknown — never mismatch — when no convention was observed (weak or ambiguous layout)", () => {
    const result = checkSpecLayout("src/Acme.Widgets", null);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("is unknown — never mismatch — for an empty repo (no convention, same null contract)", () => {
    // layout-convention.ts already collapses "empty repo" to null; this pins
    // that the check treats it identically to a weak/ambiguous convention.
    const result = checkSpecLayout("src/whatever", null);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("is unknown — never mismatch — when folderStructure has no parseable path", () => {
    const result = checkSpecLayout("Follow the existing patterns in the codebase.", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("is unknown for an empty folderStructure string", () => {
    const result = checkSpecLayout("", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("never judges a repo-root ('') project convention — always unknown for that kind", () => {
    const rootConvention: LayoutConvention = {
      projectsDir: "",
      projectsCount: 5,
      projectManifestName: "package.json",
      totalExamples: 5,
    };
    const result = checkSpecLayout("packages/deep/nested/Acme.Widgets", rootConvention);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("skips a candidate whose kind has no observed root (e.g. no testsDir) without flagging it", () => {
    const projectOnlyConvention: LayoutConvention = {
      projectsDir: "src/src",
      projectsCount: 5,
      projectManifestName: "<Name>.csproj",
      totalExamples: 5,
    };
    // "src/tests/Acme.Widgets.Tests" is test-kind, but no testsDir was observed
    // — must not be flagged as a mismatch (nothing to compare it against).
    const result = checkSpecLayout("src/tests/Acme.Widgets.Tests", projectOnlyConvention);
    expect(result.status).toBe("unknown");
    expect(result.findings).toEqual([]);
  });

  it("dedupes an identical path mentioned twice into a single finding", () => {
    const result = checkSpecLayout("src/Acme.Widgets, src/Acme.Widgets", DOTNET_STYLE_CONVENTION);
    expect(result.status).toBe("mismatch");
    expect(result.findings).toHaveLength(1);
  });

  describe("adversarial-input hardening (acceptance review)", () => {
    it("still reports the analyzer + test paths from real prose with commas and parens, and never build/", () => {
      // The actual live-bug shape: free text with parenthetical asides and a
      // build-output mention that must NOT be judged as a project claim.
      const result = checkSpecLayout(
        "src/X (analyzer code), src/X.Tests (unit tests), build/ (nuget output)",
        DOTNET_STYLE_CONVENTION,
      );
      expect(result.status).toBe("mismatch");
      expect(result.findings).toEqual([
        { path: "src/X", expectedRoot: "src/src", kind: "project" },
        { path: "src/X.Tests", expectedRoot: "src/tests", kind: "test" },
      ]);
      expect(result.findings.some((f) => f.path.includes("build"))).toBe(false);
    });

    it("is unknown for Windows-backslash paths (no forward slash to parse) rather than guessing", () => {
      const result = checkSpecLayout("src\\src\\Acme.Foo\\Acme.Foo.csproj", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a conforming absolute Windows-drive path — never inverted into a false mismatch", () => {
      // Regression: extraction used to drop the "C:/repo/" prefix, leaving a
      // truncated "repo/src/src/Acme.Foo" candidate that failed the root
      // check even though the full path IS under the observed convention.
      const result = checkSpecLayout("C:/repo/src/src/Acme.Foo", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a conforming absolute POSIX path — never inverted into a false mismatch", () => {
      const result = checkSpecLayout("/home/user/repo/src/src/Acme.Foo", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a NON-conforming absolute path too — an absolute prefix is always skipped, not resolved", () => {
      const result = checkSpecLayout("/home/user/repo/src/Acme.Foo", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a URL, even one whose tail looks conforming", () => {
      const result = checkSpecLayout(
        "https://github.com/acme/repo/tree/main/src/src/Acme.Foo",
        DOTNET_STYLE_CONVENTION,
      );
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a git@-style SSH URL", () => {
      const result = checkSpecLayout("git@github.com/acme/repo/src/src/Acme.Foo", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is unknown for a file leaf (Program.cs) — judges nothing rather than the file itself", () => {
      const result = checkSpecLayout("src/Program.cs", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("judges the parent directory of a file leaf when the parent has enough segments", () => {
      // The file segment is stripped; "src/Acme.Foo" (the parent) is still a
      // plausible project-directory claim and gets judged normally.
      const result = checkSpecLayout("src/Acme.Foo/Program.cs", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("mismatch");
      expect(result.findings).toEqual([{ path: "src/Acme.Foo/Program.cs", expectedRoot: "src/src", kind: "project" }]);
    });

    it("is unknown for a docs path — documentation is legitimately outside the project convention", () => {
      const result = checkSpecLayout("docs/architecture/overview.md", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("unknown");
      expect(result.findings).toEqual([]);
    });

    it("is ok — not mismatch — when the only non-conforming token is an excluded docs/ path", () => {
      const result = checkSpecLayout("src/src/Acme.A, src/src/Acme.B, docs/readme.md", DOTNET_STYLE_CONVENTION);
      expect(result.status).toBe("ok");
      expect(result.findings).toEqual([]);
    });

    it("flags a monorepo packages/x path against a plain 'src' project convention (legitimate mismatch)", () => {
      const monorepoConvention: LayoutConvention = {
        projectsDir: "src",
        projectsCount: 10,
        projectManifestName: "package.json",
        totalExamples: 10,
      };
      const result = checkSpecLayout("packages/acme-foo", monorepoConvention);
      expect(result.status).toBe("mismatch");
      expect(result.findings).toEqual([{ path: "packages/acme-foo", expectedRoot: "src", kind: "project" }]);
    });
  });
});

describe("formatSpecLayoutCorrection", () => {
  it("returns null for a non-mismatch result", () => {
    expect(formatSpecLayoutCorrection({ status: "ok", findings: [] })).toBeNull();
    expect(formatSpecLayoutCorrection({ status: "unknown", findings: [] })).toBeNull();
  });

  it("names the observed root for a mismatch", () => {
    const text = formatSpecLayoutCorrection({
      status: "mismatch",
      findings: [{ path: "src/Acme.Widgets", expectedRoot: "src/src", kind: "project" }],
    });
    expect(text).toContain("src/Acme.Widgets");
    expect(text).toContain("src/src");
    expect(text).toMatch(/MUST use the observed root/);
  });
});
