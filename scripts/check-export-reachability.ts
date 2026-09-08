/**
 * scripts/check-export-reachability.ts
 *
 * Gate: a value export ADDED by this change must be reachable from a shipped
 * entry point — not merely compiled, and not merely exercised by a test.
 *
 * Why it exists: two /ideal sprints (3f8451ec, e25cf471) each shipped a
 * sophisticated new exported mechanism that nothing on the live path imports,
 * while hacking the real code path separately. tsc, the full suite, the axis
 * referee and a purpose-built safety net were green both times. See the header
 * of scripts/lib/export-reachability.ts for the full shape.
 *
 * Usage:
 *   bun scripts/check-export-reachability.ts                 # working tree, warn-only
 *   bun scripts/check-export-reachability.ts --strict        # exit 1 on findings
 *   bun scripts/check-export-reachability.ts --since <ref>   # explicit baseline
 *   bun scripts/check-export-reachability.ts --rev <sha>     # analyse a commit vs its parent
 *   bun scripts/check-export-reachability.ts --all           # whole-repo backlog (no diff scope)
 *   bun scripts/check-export-reachability.ts --json
 *
 * Exit: 0 unless --strict and there is at least one finding.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AnalyzeResult,
  analyze,
  analyzeRevision,
  changedFilesSince,
  readBaselineSources,
  resolveBaseline,
  revExists,
} from "./lib/export-reachability.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const STRICT = argv.includes("--strict");
const JSON_OUT = argv.includes("--json");
const ALL = argv.includes("--all");
const REV = flag("--rev");
const SINCE = flag("--since");

function run(): AnalyzeResult {
  if (ALL) return analyze({ treeRoot: REPO_ROOT, all: true, baselineLabel: "(none — --all)" });

  if (REV) {
    if (!revExists(REPO_ROOT, REV)) {
      console.error(
        `✖  check-export-reachability: revision '${REV}' is not present in this clone — nothing to analyse.`,
      );
      process.exit(2);
    }
    return analyzeRevision(REPO_ROOT, REV);
  }

  const { ref, warnings } = resolveBaseline(REPO_ROOT, SINCE);
  if (!ref) {
    // Cannot measure a diff without git. Report and pass — a gate that cannot
    // see the change must not invent a verdict.
    return {
      findings: [],
      stats: {
        filesScanned: 0,
        reachableModules: 0,
        entryPoints: 0,
        changedFiles: 0,
        candidates: 0,
        baseline: null,
        warnings: [...warnings, "skipped: no usable git baseline"],
      },
    };
  }
  const changedFiles = changedFilesSince(REPO_ROOT, ref);
  const baselineSources = readBaselineSources(REPO_ROOT, ref, changedFiles);
  return analyze({
    treeRoot: REPO_ROOT,
    changedFiles,
    baselineSources,
    baselineLabel: ref,
    warnings,
  });
}

const started = Date.now();
const result = run();
const elapsedMs = Date.now() - started;

if (JSON_OUT) {
  console.log(JSON.stringify({ ...result, elapsedMs }, null, 2));
} else {
  const { findings, stats } = result;
  for (const w of stats.warnings) console.warn(`⚠  check-export-reachability: ${w}`);

  if (findings.length === 0) {
    console.log(
      `✔  check-export-reachability: no unreachable new exports. ` +
        `(${stats.changedFiles} changed file(s), ${stats.candidates} new value export(s), ` +
        `${stats.filesScanned} files scanned, ${stats.reachableModules} reachable from ${stats.entryPoints} entry points, ${elapsedMs}ms)`,
    );
  } else {
    console.error(`\n✖  check-export-reachability: ${findings.length} new export(s) reach no shipped entry point.\n`);
    for (const f of findings) {
      const label = f.kind === "test-only" ? "imported ONLY by tests" : "imported by nothing";
      console.error(`  ${f.file}:${f.line}  ${f.symbol}  — ${label}`);
      if (f.testImporters.length) console.error(`      test importers: ${f.testImporters.join(", ")}`);
      if (f.shadowsExistingExport) {
        console.error(`      NOTE: '${f.symbol}' is already exported by ${f.shadowsExistingExport} — likely a dead twin.`);
      }
      console.error(
        `      → Wire it into the path an entry point actually runs, or delete it. A test that exercises\n` +
          `        this symbol is not evidence about shipped behaviour.\n`,
      );
    }
    console.error(
      `  Baseline: ${stats.baseline}. Scanned ${stats.filesScanned} files, ${stats.reachableModules} reachable from ${stats.entryPoints} entry points. ${elapsedMs}ms\n`,
    );
  }
}

process.exit(STRICT && result.findings.length > 0 ? 1 : 0);
