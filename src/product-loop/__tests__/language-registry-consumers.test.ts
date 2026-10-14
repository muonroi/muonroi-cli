// src/product-loop/__tests__/language-registry-consumers.test.ts
/**
 * The five remaining hand-written "which extensions are source code" copies,
 * converged onto `language-registry.ts`.
 *
 * ## Why this file exists at all
 *
 * `language-registry.ts`'s own header records the first instance: `repo-audit.ts`
 * lacked `.cs` while `discovery-detection.ts` had it, so `auditRepo` reported
 * "Source files: 1, test files: 0" for a 506-file C# repository. Its author wrote
 * that adding `.cs` to the second list "would only have reset the clock until the
 * next language" — and the clock ran out twice more in consumers that migration
 * missed: `evidenceLooksValid` could not validate a C# citation
 * (`evidence-extensions.test.ts`), and `_estimateProjectSize` counted 1 of 1717
 * `.cs` files so three C# repos told the router they were "small"
 * (`project-size-registry.test.ts`, commit 9c156e01).
 *
 * Every copy below contained `.cs` at the time of writing, so none of them
 * carried THAT blind spot. They were converged for the NEXT language: on
 * f70968ec the registry held 36 extensions and these five sites listed 15, 11,
 * 11, 10 and 19 of them.
 *
 * ## The load-bearing pin
 *
 * `every registered source extension reaches every converged consumer` is the
 * whole point of the file. It ENUMERATES `CODE_EXTENSIONS` and drives each
 * consumer over a real fixture, exactly as `language-registry.test.ts` does for
 * `auditRepo` + `detectExistingProject` and `project-size-registry.test.ts` does
 * for `estimateProjectSizeAt`. Hand-writing the expected list here would
 * reintroduce the drift being prevented — that is why `CODE_EXTENSIONS` carries
 * its `@testonly` note instead of being hidden.
 *
 * ## The two lists that are NOT a straight substitution
 *
 * `layer1-intent.ts`'s `FILE_REF_RE` and `layer1_5-complexity-size.ts`'s
 * `PATH_TOKEN_RE` answer "does this prompt name a FILE?", not "is this a source
 * file", so they deliberately also match `.md` / `.json` / `.yml` / `.sh` /
 * `.ps1`. They follow the shape `reality-anchor.ts` and `plan-target-paths.ts`
 * established: the registry owns the LANGUAGE half, a documented local addition
 * (`PROMPT_FILE_EXTENSIONS`) owns the rest. The second describe block pins that
 * the non-code half still matches everything it matched before.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatherCodebaseIntel } from "../../maintain/codebase-intel.js";
import { generateRepoMap } from "../../maintain/repo-map.js";
import { PROMPT_FILE_EXTENSIONS } from "../../pil/file-ref-extensions.js";
import { extractPathTokens } from "../../pil/layer1_5-complexity-size.js";
import { scoreSufficiency } from "../../pil/layer1-intent.js";
import { isEcosystemBiasEnabled, shouldApplyEcosystemBias } from "../discovery-ecosystem.js";
import { CODE_EXTENSIONS } from "../language-registry.js";

/** Run `fn` against a throwaway directory seeded by `seed`, then remove it. */
async function withFixture<T>(seed: (dir: string) => void, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "langreg-consumers-"));
  try {
    seed(dir);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** An extension that no registry language claims and no local addition names. */
const UNREGISTERED_EXT = ".qqzz";

describe("every registered source extension reaches every converged consumer", () => {
  /**
   * `shouldApplyEcosystemBias`'s cwd probe: a directory holding one source file
   * is NOT greenfield, so the Muonroi-ecosystem preamble must be suppressed.
   * Pushing .NET/BB defaults onto an existing repo is the regression its header
   * cites (session cfc711c57df0).
   */
  it("discovery-ecosystem's greenfield probe sees a lone source file of any language", async () => {
    // Asserted first so the loop below cannot pass vacuously: if the setting were
    // OFF, `shouldApplyEcosystemBias` would return false for EVERY input and
    // "suppressed" would prove nothing.
    expect(isEcosystemBiasEnabled(), "the probe is only reached while the setting is ON").toBe(true);
    const emptyDir = await withFixture(
      () => undefined,
      (dir) => shouldApplyEcosystemBias({ cwd: dir }),
    );
    expect(emptyDir, "an empty directory is greenfield — bias applies").toBe(true);

    for (const ext of CODE_EXTENSIONS) {
      const greenfield = await withFixture(
        (dir) => writeFileSync(join(dir, `module${ext}`), "// sample\n", "utf8"),
        (dir) => shouldApplyEcosystemBias({ cwd: dir }),
      );
      expect(greenfield, `a lone module${ext} must disqualify the cwd from greenfield`).toBe(false);
    }
  });

  it("discovery-ecosystem's probe still calls a directory with no recognised file greenfield", async () => {
    const greenfield = await withFixture(
      (dir) => writeFileSync(join(dir, `notes${UNREGISTERED_EXT}`), "x\n", "utf8"),
      (dir) => shouldApplyEcosystemBias({ cwd: dir }),
    );
    expect(greenfield).toBe(true);
  });

  /**
   * The manifest half of the same probe was its own hand-copy, and it had
   * diverged too: `Directory.Packages.props`, `global.json`, `.slnx`, `.fsproj`,
   * `.vbproj` and `build.gradle.kts` are all in `MANIFEST_SPECS` and were all
   * absent from it.
   */
  it.each([
    ["package.json", "{}"],
    ["Cargo.toml", "[package]"],
    ["go.mod", "module x"],
    ["pyproject.toml", "[tool]"],
    ["pom.xml", "<project/>"],
    ["build.gradle", ""],
    ["build.gradle.kts", ""],
    ["Directory.Build.props", "<Project/>"],
    ["Directory.Packages.props", "<Project/>"],
    ["global.json", "{}"],
    ["App.sln", ""],
    ["App.slnx", ""],
    ["App.csproj", "<Project/>"],
    ["App.fsproj", "<Project/>"],
    ["App.vbproj", "<Project/>"],
  ])("discovery-ecosystem's probe sees the manifest %s", async (name, body) => {
    const greenfield = await withFixture(
      (dir) => writeFileSync(join(dir, name), body, "utf8"),
      (dir) => shouldApplyEcosystemBias({ cwd: dir }),
    );
    expect(greenfield, `${name} proves a project — not greenfield`).toBe(false);
  });

  /**
   * `gatherCodebaseIntel` ranks candidate files for a maintenance task by walking
   * the tree; a file whose extension it does not recognise is never scored, so it
   * can never be proposed as the file to change.
   */
  it("codebase-intel ranks a candidate of every registered language", async () => {
    const exts = [...CODE_EXTENSIONS];
    const intel = await withFixture(
      (dir) => {
        mkdirSync(join(dir, "src"), { recursive: true });
        exts.forEach((ext, i) => {
          // `widgetcache` is the task keyword: +5 for a basename hit, which is what
          // puts the file in `candidateFiles` at all.
          writeFileSync(join(dir, "src", `widgetcache${i}${ext}`), "// widgetcache\n", "utf8");
        });
        writeFileSync(join(dir, "src", `widgetcache${UNREGISTERED_EXT}`), "// widgetcache\n", "utf8");
      },
      (dir) =>
        gatherCodebaseIntel({
          cwd: dir,
          task: { title: "widgetcache", description: "widgetcache eviction", kind: "refactor" },
          maxCandidates: 500,
        }),
    );

    const ranked = intel.candidateFiles.map((c) => c.path);
    for (const [i, ext] of exts.entries()) {
      expect(ranked, `src/widgetcache${i}${ext} must be rankable as a candidate`).toContain(
        `src/widgetcache${i}${ext}`,
      );
    }
    // Falsifiability: the set is DERIVED, not "anything with a dot".
    expect(ranked).not.toContain(`src/widgetcache${UNREGISTERED_EXT}`);
  });

  /**
   * `generateRepoMap` annotates each file with its top-of-file comment. An
   * unrecognised extension gets no description, so the map the maintenance
   * planner reads describes the repo as a bare list of names.
   *
   * One fixture per extension on purpose: `MAX_GENERATE_CHARS` is 1800 and 36
   * described files overflow it, which would truncate the map and make the
   * assertion measure the cap rather than the gate.
   */
  it("repo-map extracts a description for every registered language", async () => {
    for (const ext of CODE_EXTENSIONS) {
      const map = await withFixture(
        (dir) => writeFileSync(join(dir, `module${ext}`), "// the marker description\n", "utf8"),
        (dir) => generateRepoMap(dir),
      );
      expect(map, `module${ext} must get a description in the repo map`).toContain(
        `module${ext} (the marker description)`,
      );
    }
  });

  it("repo-map leaves an unrecognised extension undescribed", async () => {
    const map = await withFixture(
      (dir) => writeFileSync(join(dir, `module${UNREGISTERED_EXT}`), "// the marker description\n", "utf8"),
      (dir) => generateRepoMap(dir),
    );
    expect(map).toContain(`module${UNREGISTERED_EXT}`);
    expect(map).not.toContain("the marker description");
  });

  /**
   * `scoreSufficiency`'s `hasFileRef` decides whether a prompt has a concrete
   * TARGET; without it a prompt naming only an unrecognised extension is routed
   * to Council to ask "fix what?". The probe text carries no concrete verb and no
   * scope noun, so the file reference is the ONLY thing that can satisfy
   * `target` — otherwise the assertion would pass for any input.
   */
  const sufficiencyProbe = (ext: string) => `please take another look at Widget${ext} when you get a chance`;

  it("layer1's FILE_REF_RE sees a file reference for every registered language", () => {
    expect(
      scoreSufficiency({ rawText: sufficiencyProbe(UNREGISTERED_EXT) }).missing,
      "control: with no recognised extension the probe is missing its target",
    ).toContain("target");

    for (const ext of CODE_EXTENSIONS) {
      const out = scoreSufficiency({ rawText: sufficiencyProbe(ext) });
      expect(out.missing, `Widget${ext} must satisfy the "target" signal`).not.toContain("target");
      expect(out.sufficient, `Widget${ext} must make the probe sufficient`).toBe(true);
    }
  });

  /**
   * `extractPathTokens` counts DISTINCT path mentions, and the count feeds the
   * size score (1 → -1, ≥3 → +2) that sets the step ceiling. A bare filename with
   * NO slash is used deliberately: the regex's other alternative matches any
   * `a/b` token regardless of extension, which would make this pass vacuously.
   */
  it("layer1_5's PATH_TOKEN_RE counts a bare filename of every registered language", () => {
    expect(
      extractPathTokens(`Widget${UNREGISTERED_EXT}`),
      "control: unrecognised extension is not a path token",
    ).toEqual([]);

    for (const ext of CODE_EXTENSIONS) {
      expect(extractPathTokens(`Widget${ext}`), `Widget${ext} must count as one path mention`).toEqual([
        `widget${ext}`,
      ]);
    }
  });
});

describe("the two prompt-reference lists keep matching their non-code extensions", () => {
  /**
   * The regression guard for the sites that were NOT a straight substitution.
   * Both PIL regexes matched documentation and config before the convergence;
   * folding in the registry must not have narrowed them.
   */
  it("layer1 still treats .md and .json as a file reference", () => {
    for (const ext of [".md", ".json"]) {
      const out = scoreSufficiency({ rawText: `please take another look at notes${ext} when you get a chance` });
      expect(out.missing, `notes${ext} was a file reference before and must stay one`).not.toContain("target");
    }
  });

  it("layer1_5 still counts every non-code extension it counted before", () => {
    // Verbatim the non-language half of the pre-convergence alternation:
    // json|md|yml|yaml|toml|sh|ps1.
    for (const ext of [".json", ".md", ".yml", ".yaml", ".toml", ".sh", ".ps1"]) {
      expect(extractPathTokens(`conf${ext}`), `conf${ext} was a path token before and must stay one`).toEqual([
        `conf${ext}`,
      ]);
    }
  });

  it("layer1_5 still counts a slash path whatever its extension", () => {
    // The first alternative is extension-agnostic and untouched.
    expect(extractPathTokens("src/orchestrator/cli-args.ts")).toEqual(["src/orchestrator/cli-args.ts"]);
    expect(extractPathTokens(`vendor/blob${UNREGISTERED_EXT}`)).toEqual([`vendor/blob${UNREGISTERED_EXT}`]);
  });

  it("the local addition is declared once and shared by both PIL sites", () => {
    // Two identical hand-lists in one directory is the drift this whole file is
    // about, so the non-code half lives in `file-ref-extensions.ts` and both
    // regexes are built from it.
    for (const ext of [".json", ".md", ".yml", ".yaml", ".toml", ".sh", ".ps1"]) {
      expect(PROMPT_FILE_EXTENSIONS.has(ext), `${ext} belongs to the shared local addition`).toBe(true);
    }
    // It is an ADDITION, not a second copy of the language set.
    for (const ext of PROMPT_FILE_EXTENSIONS) {
      expect(CODE_EXTENSIONS.has(ext), `${ext} must not duplicate a registered language`).toBe(false);
    }
  });

  /**
   * A DECLARED consequence of deriving the language half, recorded rather than
   * hidden. Before the convergence `PATH_TOKEN_RE` had no trailing boundary, so
   * `Foo.csproj` matched as the truncated token `foo.cs` and
   * `TCISLibraries.sln` matched not at all. Registering C/C++ brings in the
   * single-letter `.c` / `.h` / `.m`, and without a boundary those match inside
   * ordinary dotted identifiers — measured: `TCIS.CodeStandards` → `tcis.c`,
   * `Muonroi.Core` → `muonroi.c`, `file.command` → `file.c`. The boundary is
   * therefore required, and with it the project-file extensions must be named
   * explicitly to keep `.csproj` / `.sln` visible at all.
   */
  it("a dotted .NET identifier is not a path token, and a project file is — in full", () => {
    expect(extractPathTokens("TCIS.CodeStandards needs a new analyzer")).toEqual([]);
    expect(extractPathTokens("namespace Muonroi.Core is the base")).toEqual([]);
    expect(extractPathTokens("the file.command handler")).toEqual([]);
    expect(extractPathTokens("update Foo.csproj and TCISLibraries.sln").sort()).toEqual([
      "foo.csproj",
      "tcislibraries.sln",
    ]);
  });
});
