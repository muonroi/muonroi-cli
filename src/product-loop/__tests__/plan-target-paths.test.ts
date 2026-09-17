/**
 * S3a follow-up — the ONE shared regex source for plan target-path extraction.
 *
 * `extractPlanTargetPaths` used to live only in sprint-runner.ts; it moved to
 * this leaf module (no imports from sprint-runner.ts, so sprint-runner.ts and
 * sprint-plan-artifact.ts can both import it with no circular dependency) and
 * sprint-runner.ts now re-exports it. This file pins:
 *   1. The move is byte-identical — same import path (`../sprint-runner.js`)
 *      that pre-existing tests already use keeps returning the same thing.
 *   2. The new `extractPlanTargetDirs` bare-directory extractor: finds
 *      directories with no extension, excludes anything already a file,
 *      dedupes, strips trailing punctuation, and rejects the URL / bare-prose
 *      false-positive shapes the acceptance review flagged.
 */

import { describe, expect, it } from "vitest";
import { extractPlanTargetDirs, extractPlanTargetPaths } from "../plan-target-paths.js";
import { extractPlanTargetPaths as extractPlanTargetPathsFromSprintRunner } from "../sprint-runner.js";

describe("extractPlanTargetPaths — moved to plan-target-paths.ts", () => {
  it("sprint-runner.ts's re-export returns exactly what the leaf module returns", () => {
    const text =
      "Register src/Acme.Widgets/Acme.Widgets.csproj and src/Acme.sln, plus tests/Acme.Widgets.Tests/Foo.cs.";
    expect(extractPlanTargetPathsFromSprintRunner(text)).toEqual(extractPlanTargetPaths(text));
  });

  it("still requires a dotted extension — a bare directory mention is not a file", () => {
    expect(extractPlanTargetPaths("under src/Acme.Widgets for details")).toEqual([]);
  });
});

describe("extractPlanTargetDirs", () => {
  it("finds a bare directory with no extension", () => {
    expect(extractPlanTargetDirs("Create the project under src/Acme.Widgets, please.")).toEqual(["src/Acme.Widgets"]);
  });

  it("excludes anything already captured as a file", () => {
    const text = "Register src/Acme.Widgets/Acme0001Analyzer.cs inside src/Acme.Widgets/Rules.";
    const files = extractPlanTargetPaths(text);
    expect(files).toEqual(["src/Acme.Widgets/Acme0001Analyzer.cs"]);
    const dirs = extractPlanTargetDirs(text, files);
    expect(dirs).toEqual(["src/Acme.Widgets/Rules"]);
    expect(dirs).not.toContain("src/Acme.Widgets/Acme0001Analyzer.cs");
  });

  it("dedupes repeated mentions of the same directory", () => {
    const text = "src/Acme.Widgets is the root. Everything under src/Acme.Widgets stays there.";
    expect(extractPlanTargetDirs(text)).toEqual(["src/Acme.Widgets"]);
  });

  it("strips trailing punctuation a sentence boundary glues onto the match", () => {
    expect(extractPlanTargetDirs("It all lives in src/Acme.Widgets.")).toEqual(["src/Acme.Widgets"]);
    expect(extractPlanTargetDirs("See (src/Acme.Widgets) for the layout.")).toEqual(["src/Acme.Widgets"]);
  });

  it("no false positive on prose like 'src/ folder' with nothing after the slash", () => {
    expect(extractPlanTargetDirs("Look under the src/ folder for details.")).toEqual([]);
    expect(extractPlanTargetDirs("Files under lib/ or app/ are out of scope.")).toEqual([]);
  });

  it("no false positive on a URL path segment sharing a known prefix name", () => {
    expect(extractPlanTargetDirs("See https://example.com/src/config for details.")).toEqual([]);
    expect(extractPlanTargetDirs("See http://github.com/acme/repo/tests/data for the fixture.")).toEqual([]);
    expect(extractPlanTargetDirs("Docs at https://docs.example.com/src/widgets for more.")).toEqual([]);
  });

  it("caps the result and respects an explicit cap", () => {
    const text = Array.from({ length: 5 }, (_, i) => `src/Dir${i}`).join(" and ");
    expect(extractPlanTargetDirs(text, [], 3)).toHaveLength(3);
  });

  it("never throws on pathological input", () => {
    expect(() => extractPlanTargetDirs("")).not.toThrow();
    expect(extractPlanTargetDirs("")).toEqual([]);
  });
});
