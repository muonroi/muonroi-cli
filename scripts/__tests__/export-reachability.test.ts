/**
 * The gate that answers: does a newly-exported symbol actually reach a shipped
 * entry point, or only a test?
 *
 * Two /ideal sprints produced the same defect on unrelated axes — a new
 * exported mechanism nothing on the live path imports, with the real code path
 * hacked separately. tsc, the full unit suite, the axis referee and a
 * purpose-built safety net were green both times, because none of them can see
 * reachability. This file is where that hole is closed.
 *
 * It lives in the unit suite deliberately. `bunx vitest run` is `package.json`'s
 * `test` script, which `src/verify/recipes.ts:263-264` folds into the /ideal
 * sprint floor's `testCommands` — the exact gate both defective sprints passed.
 * A dedicated `check` script would NOT work: `verify-floor.ts:152` filters any
 * command matching /(?:^|\s)(?:lint|check)$/ out of the floor by default, so a
 * gate named `check` is silently dropped.
 *
 * Escape hatch (matching SELF_VERIFY_PRE_PUSH / MUONROI_SPRINT_SELF_VERIFY):
 *   MUONROI_EXPORT_REACHABILITY=0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyze,
  analyzeRevision,
  changedFilesSince,
  type Finding,
  readBaselineSources,
  resolveBaseline,
  revExists,
} from "../lib/export-reachability.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DISABLED = process.env.MUONROI_EXPORT_REACHABILITY === "0";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-fixture-"));
  tempDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

const symbolsOf = (findings: Finding[]): string[] => findings.map((f) => f.symbol).sort();

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fixtures — the two observed shapes, isolated
// ─────────────────────────────────────────────────────────────────────────────

describe("export reachability — signal", () => {
  const BASE_MOD = `export function live(): string {\n  return "live";\n}\n`;

  const treeFiles = {
    "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
    "src/index.ts": `import { live } from "./mod.js";\nexport function main(): string {\n  return live();\n}\n`,
    "src/mod.ts":
      BASE_MOD +
      // exp-3's shape: exported, imported by NOTHING.
      `export function deadTwin(): string {\n  return "dead";\n}\n` +
      // exp-2's shape: exported, imported ONLY by a test.
      `export function testOnlyMechanism(): string {\n  return "test-only";\n}\n` +
      // A declared test seam — the repo's leading-underscore convention.
      `export function _resetModForTests(): void {}\n` +
      // A declared test seam via tag.
      `/** @testonly */\nexport function peekModState(): number {\n  return 1;\n}\n` +
      // Exported but used inside its own (reachable) module.
      `export function usedInternally(): string {\n  return "x";\n}\n` +
      `export function alsoLive(): string {\n  return usedInternally();\n}\n` +
      // A type — no runtime behaviour, never a finding.
      `export interface NewShape {\n  a: number;\n}\n`,
    "src/__tests__/mod.test.ts": `import { testOnlyMechanism, _resetModForTests, peekModState } from "../mod.js";\nconsole.log(testOnlyMechanism(), _resetModForTests, peekModState);\n`,
  };

  const run = () =>
    analyze({
      treeRoot: scaffold(treeFiles),
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    });

  it("flags a new export that nothing imports (exp-3's shape)", () => {
    const dead = run().findings.filter((f) => f.kind === "dead");
    expect(symbolsOf(dead)).toContain("deadTwin");
  });

  it("flags a new export imported only by a test, and names the test (exp-2's shape)", () => {
    const hit = run().findings.find((f) => f.symbol === "testOnlyMechanism");
    expect(hit?.kind).toBe("test-only");
    expect(hit?.testImporters).toEqual(["src/__tests__/mod.test.ts"]);
  });

  it("stays silent on live, internally-used, seam-marked and type exports", () => {
    // `alsoLive` is unimported too, but it is NOT new — only diff-scoped
    // symbols are candidates, and the baseline already had `live`.
    expect(symbolsOf(run().findings)).toEqual(["alsoLive", "deadTwin", "testOnlyMechanism"]);
    // Explicitly: the seams and the type are absent.
    const names = symbolsOf(run().findings);
    expect(names).not.toContain("_resetModForTests");
    expect(names).not.toContain("peekModState");
    expect(names).not.toContain("usedInternally");
    expect(names).not.toContain("NewShape");
    expect(names).not.toContain("live");
  });

  it("does not flag a new export that IS wired into an entry point", () => {
    const dir = scaffold({
      ...treeFiles,
      "src/index.ts": `import { live, deadTwin } from "./mod.js";\nexport function main(): string {\n  return live() + deadTwin();\n}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(symbolsOf(findings)).not.toContain("deadTwin");
  });

  it("treats a symbol re-exported by a package's public surface as API, not dead", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
      "src/index.ts": `export * from "./mod.js";\n`,
      "src/mod.ts": `${BASE_MOD}export function brandNewPublicApi(): number {\n  return 1;\n}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(symbolsOf(findings)).not.toContain("brandNewPublicApi");
  });

  // Both of these were measured OPEN before being closed. A dead symbol must
  // not be launderable into "reached" by one line that never runs it.
  it("an unused import from a live module does not count as reaching the symbol", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
      // index.ts imports deadTwin and never calls it.
      "src/index.ts": `import { live, deadTwin } from "./mod.js";\nexport const m = live();\n`,
      "src/mod.ts": `${BASE_MOD}export function deadTwin(): string {\n  return "dead";\n}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(findings.find((f) => f.symbol === "deadTwin")?.kind).toBe("dead");
  });

  it("a barrel re-export nobody consumes does not count as reaching the symbol", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
      "src/index.ts": `import { live } from "./barrel.js";\nexport const m = live();\n`,
      "src/barrel.ts": `export { live, deadTwin } from "./mod.js";\n`,
      "src/mod.ts": `${BASE_MOD}export function deadTwin(): string {\n  return "dead";\n}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(findings.find((f) => f.symbol === "deadTwin")?.kind).toBe("dead");
  });

  it("a real call site through a barrel DOES count", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
      "src/index.ts": `import { live, deadTwin } from "./barrel.js";\nexport const m = live() + deadTwin();\n`,
      "src/barrel.ts": `export { live, deadTwin } from "./mod.js";\n`,
      "src/mod.ts": `${BASE_MOD}export function deadTwin(): string {\n  return "dead";\n}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(symbolsOf(findings)).not.toContain("deadTwin");
  });

  it("a test-seam marker cannot rescue a symbol nothing imports at all", () => {
    const dir = scaffold({
      "package.json": JSON.stringify({ name: "fx", main: "dist/src/index.js" }),
      "src/index.ts": `import { live } from "./mod.js";\nexport const m = live;\n`,
      "src/mod.ts": `${BASE_MOD}/** @testonly */\nexport function _totallyUnused(): void {}\n`,
    });
    const findings = analyze({
      treeRoot: dir,
      changedFiles: ["src/mod.ts"],
      baselineSources: new Map([["src/mod.ts", BASE_MOD]]),
    }).findings;
    expect(findings.find((f) => f.symbol === "_totallyUnused")?.kind).toBe("dead");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real fixtures — the two commits this check exists because of
// ─────────────────────────────────────────────────────────────────────────────

describe("export reachability — historical defect fixtures", () => {
  const fixtures: Array<{ rev: string; label: string; file: string; symbol: string; kind: Finding["kind"] }> = [
    {
      rev: "3f8451ec",
      label: "exp-2 — a second runHeadless the shipped CLI never calls",
      file: "src/headless/output.ts",
      symbol: "runHeadless",
      kind: "test-only",
    },
    {
      rev: "e25cf471",
      label: "exp-3 — a reduceCardKey twin of the live council-question-card one",
      file: "src/ui/utils/format.ts",
      symbol: "reduceCardKey",
      kind: "dead",
    },
  ];

  for (const fx of fixtures) {
    // Guarded: a shallow CI clone may not carry these objects. Skipping is
    // honest; asserting against a missing rev would be a fabricated pass.
    const present = revExists(REPO_ROOT, fx.rev);
    it.skipIf(!present)(
      `fires on ${fx.rev} (${fx.label})`,
      () => {
        const { findings } = analyzeRevision(REPO_ROOT, fx.rev);
        const hit = findings.find((f) => f.symbol === fx.symbol && f.file === fx.file);
        expect(hit, `expected ${fx.symbol} at ${fx.file} in ${JSON.stringify(symbolsOf(findings))}`).toBeDefined();
        expect(hit?.kind).toBe(fx.kind);
        // Precision matters as much as sensitivity: the defect must not arrive
        // buried in noise, or the report gets skimmed and the finding missed.
        expect(findings.length).toBe(1);
      },
      60_000,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate itself
// ─────────────────────────────────────────────────────────────────────────────

describe("export reachability — gate on this working tree", () => {
  it.skipIf(DISABLED)(
    "every value export added by this change reaches a shipped entry point",
    () => {
      const { ref, warnings } = resolveBaseline(REPO_ROOT);
      if (!ref) {
        // Fail open, loudly. A gate that cannot see the diff must not invent a
        // verdict — but it must say so rather than pass in silence.
        console.warn(
          `[export-reachability] gate skipped: no usable git baseline (${warnings.join("; ") || "unknown"})`,
        );
        return;
      }
      const changedFiles = changedFilesSince(REPO_ROOT, ref);
      const { findings } = analyze({
        treeRoot: REPO_ROOT,
        changedFiles,
        baselineSources: readBaselineSources(REPO_ROOT, ref, changedFiles),
        baselineLabel: ref,
      });

      const report = findings
        .map(
          (f) =>
            `  ${f.file}:${f.line} ${f.symbol} — ${f.kind === "test-only" ? `imported ONLY by tests (${f.testImporters.join(", ")})` : "imported by nothing"}` +
            (f.shadowsExistingExport ? ` [already exported by ${f.shadowsExistingExport}]` : ""),
        )
        .join("\n");

      expect(
        findings,
        `New exports that reach no shipped entry point (baseline ${ref}):\n${report}\n\n` +
          `Wire each into the path an entry point runs, or delete it. A test that exercises\n` +
          `one of these is not evidence about shipped behaviour. If it is a deliberate test\n` +
          `seam, mark it: leading underscore in the name, or a /** @testonly */ tag.\n` +
          `Details: bun scripts/check-export-reachability.ts\n`,
      ).toEqual([]);
    },
    120_000,
  );
});
