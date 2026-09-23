/**
 * Project SIZE — the third consumer that carried its own extension list.
 *
 * ## What was wrong
 *
 * `_estimateProjectSize` used an inline `/\.(ts|tsx|js|jsx|py|go|rs)$/`. Measured
 * on this machine: `tcis-libraries/src` holds 1717 `.cs` files and that regex
 * matched exactly ONE, so the repo was reported `small` (threshold `<= 20`).
 * `muonroi-building-block/src` (2058 `.cs`) likewise.
 *
 * This is NOT a cosmetic label. The bucket travels `message-processor.ts`
 * (`projectSize: deps.estimateProjectSize()`) → `buildRouteContext` in
 * `router/decide.ts` → the EE router's classify prompt as `project=<size>`, so it
 * is an input to model/tier selection on every turn.
 *
 * ## What these tests pin
 *
 * 1. A C# tree is no longer `small`.
 * 2. The LANGUAGE set comes from `language-registry.ts` and nowhere else, in the
 *    spirit of `language-registry.test.ts`'s "the two extension lists cannot
 *    diverge again": every registered extension is counted here, so a language
 *    added to `SOURCE_LANGUAGES` reaches this consumer with no edit.
 * 3. Build output does not inflate the count — a .NET `obj/` holds generated `.cs`.
 * 4. Project manifests are NOT counted toward size (they ARE valid evidence; see
 *    `evidence-extensions.test.ts` for the other side of that split).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, SOURCE_LANGUAGES } from "../../product-loop/language-registry.js";
import {
  bucketForCodeFileCount,
  estimateProjectSizeAt,
  PROJECT_SIZE_MEDIUM_MAX,
  PROJECT_SIZE_SMALL_MAX,
} from "../project-size.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "project-size-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Write `n` files with the given extension under `<cwd>/src/<sub>`. */
function seed(ext: string, n: number, sub = ""): void {
  const dir = sub ? join(cwd, "src", sub) : join(cwd, "src");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `File${i}${ext}`), "// x\n", "utf8");
}

describe("estimateProjectSizeAt — a C# tree is not 'small'", () => {
  it("buckets a 40-file C# tree as medium, not small", () => {
    // 40 is past PROJECT_SIZE_SMALL_MAX (20) and within MEDIUM_MAX (100). Under the
    // old regex every one of these counted as ZERO, so the answer was `small`.
    seed(".cs", 40);
    expect(estimateProjectSizeAt(cwd)).toBe("medium");
  });

  it("buckets a 150-file C# tree as large — the tcis-libraries shape", () => {
    seed(".cs", 150);
    expect(estimateProjectSizeAt(cwd)).toBe("large");
  });

  it("counts C# nested in a real .NET layout (src/src/Project/Analyzers/…)", () => {
    // Mirrors the actual paths in muauw6u93e1c's diffFiles:
    // `src/src/TCIS.CodeStandards/Analyzers/TCIS0001_MaxLineLengthAnalyzer.cs`.
    seed(".cs", 30, join("src", "TCIS.CodeStandards", "Analyzers"));
    expect(estimateProjectSizeAt(cwd)).toBe("medium");
  });

  it("still reports small for a genuinely small tree", () => {
    seed(".cs", 5);
    expect(estimateProjectSizeAt(cwd)).toBe("small");
  });

  it("returns null when there is no src/ — an honest absence of signal", () => {
    expect(estimateProjectSizeAt(cwd)).toBeNull();
  });
});

describe("the language set comes from the registry, not from this module", () => {
  it("counts EVERY registered source extension", () => {
    // The load-bearing pin: enumerating the registry (rather than hand-writing a
    // list here) is what makes a newly registered language reach this consumer.
    // A hand-written list in the test would reintroduce exactly the drift being
    // prevented — same reasoning as `CODE_EXTENSIONS`' `@testonly` note.
    for (const ext of CODE_EXTENSIONS) {
      const dir = mkdtempSync(join(tmpdir(), "project-size-ext-"));
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        for (let i = 0; i < PROJECT_SIZE_SMALL_MAX + 1; i++) {
          writeFileSync(join(dir, "src", `File${i}${ext}`), "// x\n", "utf8");
        }
        expect(estimateProjectSizeAt(dir), `${ext} must be counted as source`).toBe("medium");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("covers C#, F# and Visual Basic specifically — the languages that were invisible", () => {
    const dotnet = SOURCE_LANGUAGES.filter((l) => ["C#", "F#", "Visual Basic"].includes(l.lang));
    expect(dotnet.map((l) => l.lang).sort()).toEqual(["C#", "F#", "Visual Basic"]);
    for (const spec of dotnet) {
      for (const ext of spec.extensions) {
        expect(CODE_EXTENSIONS.has(ext), `${ext} (${spec.lang})`).toBe(true);
      }
    }
  });

  it("does not count files whose extension is not a registered language", () => {
    seed(".md", 50);
    seed(".json", 50);
    expect(estimateProjectSizeAt(cwd)).toBe("small");
  });
});

describe("build output and project manifests do not inflate SIZE", () => {
  it("ignores generated .cs under obj/ (BUILD_OUTPUT_DIRS)", () => {
    // On tcis-libraries/src the same walk counts 1718 code files including obj/
    // and 947 excluding it — 771 generated AssemblyInfo/GlobalUsings files.
    seed(".cs", 5);
    seed(".cs", 200, join("TCIS.Thing", "obj", "Debug", "net8.0"));
    expect(estimateProjectSizeAt(cwd)).toBe("small");
  });

  it("ignores node_modules, dist and target too", () => {
    seed(".cs", 5);
    seed(".ts", 100, "node_modules");
    seed(".ts", 100, "dist");
    seed(".rs", 100, "target");
    expect(estimateProjectSizeAt(cwd)).toBe("small");
  });

  it("still counts files under bin/, which is deliberately NOT build output", () => {
    // The registry excludes `bin` on purpose: it is a legitimate source directory
    // in Node and Python repos and holds no `.cs` in a .NET tree.
    seed(".py", PROJECT_SIZE_SMALL_MAX + 1, "bin");
    expect(estimateProjectSizeAt(cwd)).toBe("medium");
  });

  it("does NOT count .sln/.csproj/.props toward size, though they are valid evidence", () => {
    // tcis-libraries/src carries 436 of these. Counting them would size a repo
    // with no logic at all as medium/large. The evidence gate accepts them; this
    // one must not — that is the documented per-caller difference.
    for (const ext of [".sln", ".csproj", ".fsproj", ".props", ".targets"]) seed(ext, 30);
    expect(estimateProjectSizeAt(cwd)).toBe("small");
  });
});

describe("bucketForCodeFileCount — boundaries unchanged by this fix", () => {
  it("keeps the original inclusive thresholds", () => {
    expect(bucketForCodeFileCount(0)).toBe("small");
    expect(bucketForCodeFileCount(PROJECT_SIZE_SMALL_MAX)).toBe("small");
    expect(bucketForCodeFileCount(PROJECT_SIZE_SMALL_MAX + 1)).toBe("medium");
    expect(bucketForCodeFileCount(PROJECT_SIZE_MEDIUM_MAX)).toBe("medium");
    expect(bucketForCodeFileCount(PROJECT_SIZE_MEDIUM_MAX + 1)).toBe("large");
  });
});
