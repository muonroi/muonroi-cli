/**
 * Tests for `buildRepoBrief` — the existing-project replacement for the
 * Muonroi vendor preamble in discovery leader prompts. Covers:
 *  - basic shape from a TS-ish temp repo
 *  - missing pieces (no README, no package.json) degrade gracefully
 *  - rationaleCitesBrief gate accepts cited and rejects uncited rationales
 *  - hard cap respected on large READMEs
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoBrief, rationaleCitesBrief } from "../repo-brief.js";
import type { ExistingProjectSignals } from "../types.js";

function makeDetection(over: Partial<ExistingProjectSignals> = {}): ExistingProjectSignals {
  return {
    isGitRepo: false,
    hasCommitHistory: false,
    srcFileCount: 10,
    manifests: [],
    languages: ["TypeScript"],
    frameworks: [],
    classification: "existing",
    ...over,
  };
}

describe("buildRepoBrief", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-repo-brief-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("includes package.json name, scripts, deps when present", async () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "@muonroi/test-pkg",
        description: "Test pkg for repo-brief",
        scripts: { build: "tsc", test: "vitest" },
        dependencies: { ai: "^1.0.0", vitest: "^4.0.0" },
      }),
    );
    const brief = await buildRepoBrief(tmp, makeDetection());
    expect(brief.markdown).toContain("@muonroi/test-pkg");
    expect(brief.markdown).toContain("Test pkg for repo-brief");
    expect(brief.markdown).toContain("`build`");
    expect(brief.markdown).toContain("`ai`");
    expect(brief.citableTokens).toContain("@muonroi/test-pkg");
    expect(brief.citableTokens).toContain("build");
    expect(brief.citableTokens).toContain("ai");
  });

  it("walks top-level dirs to depth 2 and skips ignored dirs", async () => {
    fs.mkdirSync(path.join(tmp, "src", "components"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "foo"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
    const brief = await buildRepoBrief(tmp, makeDetection());
    expect(brief.markdown).toContain("`src/`");
    expect(brief.markdown).toContain("`components/`");
    expect(brief.markdown).toContain("`hooks/`");
    expect(brief.markdown).toContain("`tests/`");
    expect(brief.markdown).not.toContain("node_modules");
    expect(brief.markdown).not.toContain(".git");
    expect(brief.citableTokens).toContain("src");
    expect(brief.citableTokens).toContain("src/components");
  });

  it("includes README head and truncates with ellipsis", async () => {
    const big = "X".repeat(900);
    fs.writeFileSync(path.join(tmp, "README.md"), `# Title\n\n${big}`);
    const brief = await buildRepoBrief(tmp, makeDetection());
    expect(brief.markdown).toContain("README head:");
    expect(brief.markdown).toContain("# Title");
    expect(brief.markdown).toContain("…");
  });

  it("includes manifests + languages + frameworks from detection", async () => {
    const brief = await buildRepoBrief(
      tmp,
      makeDetection({
        languages: ["TypeScript", "Rust"],
        frameworks: ["react", "vite"],
        manifests: [
          {
            file: path.join(tmp, "package.json"),
            type: "package.json",
            weight: 1,
            inferredLang: "TypeScript",
            inferredFrameworks: ["react"],
          },
        ],
      }),
    );
    expect(brief.markdown).toContain("TypeScript, Rust");
    expect(brief.markdown).toContain("react, vite");
    expect(brief.markdown).toContain("package.json");
    expect(brief.citableTokens).toContain("react");
    expect(brief.citableTokens).toContain("package.json");
  });

  it("degrades gracefully when nothing is present (empty dir)", async () => {
    const brief = await buildRepoBrief(tmp, makeDetection({ languages: [], srcFileCount: 0 }));
    expect(brief.markdown).toContain("Repo brief");
    expect(brief.markdown).toContain("Rationales for ANY recommendation MUST cite");
    // citableTokens may still be empty for an empty dir — acceptable.
    expect(Array.isArray(brief.citableTokens)).toBe(true);
  });

  it("caps total markdown length at 1200 chars", async () => {
    fs.writeFileSync(path.join(tmp, "README.md"), "Z".repeat(5000));
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "x",
        scripts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, `cmd${i}`])),
        dependencies: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`dep${i}`, "1"])),
      }),
    );
    const brief = await buildRepoBrief(tmp, makeDetection());
    expect(brief.markdown.length).toBeLessThanOrEqual(1200);
  });
});

describe("rationaleCitesBrief", () => {
  const briefStub = {
    markdown: "(unused)",
    citableTokens: ["src", "package.json", "discovery-recommender.ts", "build"],
  };

  it("returns true when rationale contains any token (case-insensitive)", () => {
    expect(rationaleCitesBrief("Reuses `src/foo.ts` to avoid duplication", briefStub)).toBe(true);
    expect(rationaleCitesBrief("Extends the existing BUILD script", briefStub)).toBe(true);
  });

  it("returns false when rationale is generic / cites nothing in brief", () => {
    expect(rationaleCitesBrief("Industry standard for SaaS apps", briefStub)).toBe(false);
    expect(rationaleCitesBrief("Best for performance and simplicity", briefStub)).toBe(false);
  });

  it("returns true when brief has no citable tokens (no expectations to enforce)", () => {
    expect(rationaleCitesBrief("anything", { markdown: "", citableTokens: [] })).toBe(true);
  });

  it("returns true when brief is undefined", () => {
    expect(rationaleCitesBrief("anything", undefined)).toBe(true);
  });
});
