/**
 * scripts/lib/export-reachability.ts
 *
 * Core detection logic for the "dead export" gate.
 *
 * ── The defect this exists to catch ──────────────────────────────────────────
 *
 * Twice, on unrelated axes, an /ideal sprint produced the same shape: a
 * sophisticated new mechanism added as an EXPORTED symbol that nothing on the
 * shipped path imports, while the live code path was hacked separately.
 *
 *   exp-2  3f8451ec  `runHeadless` added at src/headless/output.ts:591.
 *                    src/index.ts imports only `type HeadlessWrites` from that
 *                    module and keeps calling its own local runHeadless.
 *                    The sprint's new 85-line test imported the DEAD one.
 *   exp-3  e25cf471  `reduceCardKey` added at src/ui/utils/format.ts:154 —
 *                    a name that ALREADY exists at
 *                    src/ui/components/council-question-card.tsx:222 and is
 *                    imported by app.tsx + use-app-logic.tsx. The new twin is
 *                    imported by nothing at all.
 *
 * tsc, the full suite, the axis referee and a purpose-built safety net were all
 * green both times. None of them can see "this code is not on any path from an
 * entry point".
 *
 * ── The signal ───────────────────────────────────────────────────────────────
 *
 * A finding is a VALUE export that
 *   (a) was ADDED by the change under measurement (diff-scoped), and
 *   (b) is not part of a published package surface, and
 *   (c) is referenced by ZERO production modules reachable from an entry point,
 *       and is not used inside its own module.
 *
 * `kind: "test-only"` when tests DO import it (exp-2's shape — the evidence
 * exercised code the product never runs); `kind: "dead"` when nothing imports
 * it at all (exp-3's shape).
 *
 * Diff scoping is what makes this usable rather than furniture: the repo
 * already carries a backlog of unreferenced exports (run with `all: true` to
 * enumerate it), and a check that reports the backlog on every run is a check
 * that gets disabled. Scoping to added symbols means a clean tree is silent by
 * construction and no allowlist is needed for history.
 *
 * Only VALUE exports are considered. `export interface` / `export type` carry
 * no runtime behaviour, so an unreferenced type is not the defect, and
 * including them would add noise for nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Finding {
  /** Repo-relative POSIX path of the module declaring the symbol. */
  file: string;
  /** 1-based line of the export declaration. */
  line: number;
  symbol: string;
  /** "dead" = nothing imports it. "test-only" = only test files import it. */
  kind: "dead" | "test-only";
  /** Repo-relative paths of the test files importing it (kind "test-only"). */
  testImporters: string[];
  /** Set when the same name is already exported by another module. */
  shadowsExistingExport?: string;
}

export interface AnalyzeResult {
  findings: Finding[];
  stats: {
    /** Files parsed. */
    filesScanned: number;
    /** Modules reachable from an entry point through prod imports. */
    reachableModules: number;
    /** Entry points discovered. */
    entryPoints: number;
    /** Files in the diff scope (0 in `all` mode). */
    changedFiles: number;
    /** Value exports considered as candidates. */
    candidates: number;
    baseline: string | null;
    /** Non-fatal degradations (git unavailable, unresolvable baseline, …). */
    warnings: string[];
  };
}

export interface AnalyzeOptions {
  /** Directory holding the tree to analyse (repo root, or an extracted rev). */
  treeRoot: string;
  /**
   * Repo-relative paths considered "changed". When omitted the analyzer
   * derives them from git. Pass `[]` with `all: false` for a no-op run.
   */
  changedFiles?: string[];
  /**
   * Map of repo-relative path -> the BASELINE contents of that file (the
   * version before the change), used to compute which exports are NEW.
   * A path absent from the map is treated as a newly-created file.
   */
  baselineSources?: Map<string, string>;
  /** Ignore the diff and report every unreferenced value export. */
  all?: boolean;
  /** Recorded in stats only. */
  baselineLabel?: string | null;
  /** Extra warnings collected by the caller (e.g. git degradation). */
  warnings?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_DIRS = ["src", "scripts", "tests", "packages"];
const SOURCE_EXT = /\.(m|c)?tsx?$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "build", "coverage", "out"]);

function walk(dir: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // Directory vanished or is unreadable — record and continue; a partial
    // scan is still useful and must not abort the gate.
    console.error(
      `[export-reachability] readdir failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch (err) {
      console.error(
        `[export-reachability] stat failed for ${full}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (st.isDirectory()) walk(full, root, out);
    else if (SOURCE_EXT.test(entry) && !entry.endsWith(".d.ts")) out.push(toRel(root, full));
  }
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

/**
 * A file whose contents are evidence, not product. Its imports do NOT count as
 * "the shipped path reaches this code".
 */
export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)__tests__\//.test(rel) ||
    /(^|\/)__test-helpers__\//.test(rel) ||
    /(^|\/)__test-stubs__\//.test(rel) ||
    /(^|\/)tests\//.test(rel) ||
    /\.(test|spec|bench)\.[cm]?tsx?$/.test(rel) ||
    /(^|\/)fixtures\//.test(rel)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Module resolution (path-based; no node_modules, so it works on any git rev)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace package name -> source directory, derived from the workspace
 * layout rather than hardcoded, so a new package is picked up automatically.
 */
function buildPackageAliases(treeRoot: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const pkgDir = join(treeRoot, "packages");
  if (!existsSync(pkgDir)) return aliases;
  for (const entry of readdirSync(pkgDir)) {
    const manifest = join(pkgDir, entry, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
      if (name) aliases.set(name, `packages/${entry}/src`);
    } catch (err) {
      console.error(
        `[export-reachability] parse failed for ${manifest}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return aliases;
}

function tryCandidates(treeRoot: string, base: string, known: Set<string>): string | null {
  // `.js` specifiers map to `.ts`/`.tsx` sources (NodeNext-style imports).
  const stripped = base.replace(/\.(m|c)?js$/, "");
  const candidates = [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.cts`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
    base,
  ];
  for (const c of candidates) {
    const norm = posix.normalize(c);
    if (known.has(norm)) return norm;
  }
  // Deliberately NO filesystem fallback: resolution must land on a file the
  // analyzer actually parsed. A build artifact (`dist/src/index.js`) exists on
  // disk in a working checkout but not in a git-extracted revision, and letting
  // it win made the root package.json `main`/`bin` resolve to dist instead of
  // src — which silently dropped src/index.ts from the entry-point set.
  return null;
}

function makeResolver(treeRoot: string, known: Set<string>) {
  const aliases = buildPackageAliases(treeRoot);
  const cache = new Map<string, string | null>();

  return function resolveSpec(fromRel: string, spec: string): string | null {
    const key = `${fromRel}\u0000${spec}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let result: string | null = null;

    if (spec.startsWith(".")) {
      const dir = posix.dirname(fromRel);
      result = tryCandidates(treeRoot, posix.join(dir, spec), known);
    } else if (spec.startsWith("@council/")) {
      // tsconfig paths: @council/* -> src/council/*.ts | src/council/*/index.ts
      result = tryCandidates(treeRoot, `src/council/${spec.slice("@council/".length)}`, known);
    } else {
      for (const [pkgName, srcDir] of aliases) {
        if (spec === pkgName) {
          result = tryCandidates(treeRoot, `${srcDir}/index`, known);
          break;
        }
        if (spec.startsWith(`${pkgName}/`)) {
          result = tryCandidates(treeRoot, `${srcDir}/${spec.slice(pkgName.length + 1)}`, known);
          break;
        }
      }
    }

    cache.set(key, result);
    return result;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ExportRecord {
  name: string;
  line: number;
  isType: boolean;
  /** `export { x } from "./m"` / `export * from "./m"` — declared elsewhere. */
  reExportedFrom?: string;
  /**
   * The author declared this export a deliberate test seam — a `@testonly`
   * (or `@test-seam`) tag in its leading comment, or the repo's existing
   * `__…ForTests` naming convention (src/providers/rate-limiter.ts:325).
   *
   * This exempts the "test-only" verdict ONLY. A symbol that nothing imports
   * at all cannot be a test seam, so the marker never suppresses "dead".
   */
  testSeamMarked: boolean;
}

const TEST_SEAM_TAG = /@test-?only|@test-seam/i;
/**
 * The convention this repo already uses for "internal, not part of any live
 * path" — a leading underscore. Measured over 400 commits it covers 13 exports
 * (`__resetRateLimiterForTests`, `__resetVisionSessions`,
 * `_resetWorkflowEventState`, …). Recognising it means an author following the
 * existing house style is never asked to do anything new.
 */
const TEST_SEAM_NAME = /^_/;

interface ImportEdge {
  /** Raw specifier. */
  spec: string;
  /** Source names pulled in (`import { a as b }` records `a`). */
  names: Set<string>;
  /** `import * as ns` / `export * from` — consumes every name of the target. */
  wildcard: boolean;
  /** `import type {…}` — a type-position reference only. */
  typeOnly: boolean;
  /**
   * True for `export … from "…"`. A barrel republishes a name; it does not USE
   * it. Counting a barrel as a consumer would let a dead symbol be laundered
   * live by adding one re-export line, so these edges feed reachability and
   * origin resolution but never the "who uses this symbol" tally.
   */
  isReExport: boolean;
  /** Source name -> the local binding it is bound to in THIS file. */
  locals: Map<string, string>;
  /** Local binding of `import * as ns`. */
  nsLocal?: string;
}

interface ParsedFile {
  rel: string;
  isTest: boolean;
  exports: ExportRecord[];
  imports: ImportEdge[];
  /** `export * from "./m"` targets — this module republishes m's names. */
  starReExports: string[];
  /**
   * Occurrences of each identifier, EXCLUDING its own export-declaration name.
   * An import clause contributes 1, so a binding that is imported and never
   * used sits at exactly 1 — which is how an unused import is told apart from
   * a real call site.
   */
  refCounts: Map<string, number>;
}

function scriptKind(rel: string): ts.ScriptKind {
  return rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function parseSource(rel: string, text: string): ParsedFile {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const exports: ExportRecord[] = [];
  const imports: ImportEdge[] = [];
  const starReExports: string[] = [];
  const refCounts = new Map<string, number>();
  const declarationNameNodes = new Set<ts.Node>();

  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  /** Leading comment text of a declaration, for `@testonly`-style markers. */
  function leadingComment(node: ts.Node): string {
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    return ranges.map((r) => text.slice(r.pos, r.end)).join("\n");
  }

  function addExport(name: string, node: ts.Node, isType: boolean, from?: string): void {
    const testSeamMarked = TEST_SEAM_NAME.test(name) || TEST_SEAM_TAG.test(leadingComment(node));
    exports.push({ name, line: lineOf(node), isType, reExportedFrom: from, testSeamMarked });
  }

  function visit(node: ts.Node): void {
    // ── import declarations ────────────────────────────────────────────────
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      const names = new Set<string>();
      const locals = new Map<string, string>();
      let wildcard = false;
      let nsLocal: string | undefined;
      if (clause) {
        if (clause.name) {
          names.add("default");
          locals.set("default", clause.name.text);
        }
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) {
            wildcard = true;
            nsLocal = nb.name.text;
          } else {
            for (const el of nb.elements) {
              const source = (el.propertyName ?? el.name).text;
              names.add(source);
              locals.set(source, el.name.text);
            }
          }
        }
      }
      imports.push({
        spec,
        names,
        wildcard,
        typeOnly: clause?.isTypeOnly === true,
        isReExport: false,
        locals,
        nsLocal,
      });
    }

    // ── export … from / export * from ──────────────────────────────────────
    if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (spec && !node.exportClause) {
        starReExports.push(spec);
        imports.push({
          spec,
          names: new Set(),
          wildcard: true,
          typeOnly: node.isTypeOnly,
          isReExport: true,
          locals: new Map(),
        });
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const names = new Set<string>();
        for (const el of node.exportClause.elements) {
          const source = (el.propertyName ?? el.name).text;
          names.add(source);
          addExport(el.name.text, el, node.isTypeOnly || el.isTypeOnly, spec);
          if (!spec) {
            // A local `export { foo }` is a declaration of intent to publish,
            // not a use of `foo`. Excluding its identifiers from the reference
            // count keeps the two-statement barrel
            // (`import { dead } from "./m"; export { dead };`) from reading as
            // a call site, exactly like the one-statement form above.
            declarationNameNodes.add(el.name);
            if (el.propertyName) declarationNameNodes.add(el.propertyName);
          }
        }
        if (spec) {
          imports.push({
            spec,
            names,
            wildcard: false,
            typeOnly: node.isTypeOnly,
            isReExport: true,
            locals: new Map(),
          });
        }
      }
    }

    // ── export declarations ────────────────────────────────────────────────
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && hasExportModifier(node) && node.name) {
      declarationNameNodes.add(node.name);
      addExport(node.name.text, node, false);
    }
    if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
      declarationNameNodes.add(node.name);
      addExport(node.name.text, node, false);
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          declarationNameNodes.add(decl.name);
          addExport(decl.name.text, node, false);
        } else {
          // Destructured export — bindings are values; record each.
          const collect = (n: ts.BindingName): void => {
            if (ts.isIdentifier(n)) {
              declarationNameNodes.add(n);
              addExport(n.text, node, false);
            } else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) {
              for (const el of n.elements) if (ts.isBindingElement(el)) collect(el.name);
            }
          };
          collect(decl.name);
        }
      }
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && hasExportModifier(node)) {
      declarationNameNodes.add(node.name);
      addExport(node.name.text, node, true);
    }
    if (ts.isModuleDeclaration(node) && hasExportModifier(node) && ts.isIdentifier(node.name)) {
      declarationNameNodes.add(node.name);
      addExport(node.name.text, node, false);
    }
    if (ts.isExportAssignment(node)) addExport("default", node, false);
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      addExport("default", node, false);
    }

    // ── dynamic import("…") / require("…") ─────────────────────────────────
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const arg = node.arguments[0];
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) {
        // A dynamic import consumes the whole module surface — we cannot see
        // which property is destructured downstream, so treat it as wildcard.
        // No `nsLocal`: an awaited import has no stable binding to count, so it
        // is accepted as a use outright rather than risking a false positive.
        imports.push({
          spec: arg.text,
          names: new Set(),
          wildcard: true,
          typeOnly: false,
          isReExport: false,
          locals: new Map(),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  // Second pass: count every identifier that is NOT the declaration name of an
  // export. Two things read this. A count >= 1 for a symbol declared HERE means
  // an exported helper is used inside its own module, so it is live. A count of
  // exactly 1 for an IMPORTED binding means the only occurrence is the import
  // clause itself — an unused import, which must not launder a dead symbol.
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !declarationNameNodes.has(node)) {
      refCounts.set(node.text, (refCounts.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, collectRefs);
  };
  collectRefs(sf);

  return { rel, isTest: isTestPath(rel), exports, imports, starReExports, refCounts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

function collectExportTargets(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectExportTargets(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectExportTargets(v, out);
}

/**
 * The real set of shipped entry points, read from the manifests rather than
 * assumed:
 *   - root package.json `main` / `bin` / `exports`   → the CLI (src/index.ts)
 *   - every packages/&#42;/package.json `main`/`module`/`types`/`exports`
 *     → the published library surfaces (@muonroi/agent-harness-*)
 *   - scripts/&#42;.ts                                     → executables invoked by
 *     package.json scripts and the husky hooks
 * Manifest targets point at build output (dist/src/index.js); they are mapped
 * back to source by path, which is why `dist/` need not exist.
 */
export function discoverEntryPoints(treeRoot: string, known: Set<string>): Set<string> {
  const roots = new Set<string>();

  const readManifest = (rel: string): Record<string, unknown> | null => {
    const abs = join(treeRoot, rel);
    if (!existsSync(abs)) return null;
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    } catch (err) {
      console.error(
        `[export-reachability] manifest parse failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };

  const addManifest = (manifestRel: string): void => {
    const pkg = readManifest(manifestRel);
    if (!pkg) return;
    const dir = posix.dirname(manifestRel) === "." ? "" : `${posix.dirname(manifestRel)}/`;
    const targets: string[] = [];
    collectExportTargets(pkg.main, targets);
    collectExportTargets(pkg.module, targets);
    collectExportTargets(pkg.types, targets);
    collectExportTargets(pkg.bin, targets);
    collectExportTargets(pkg.exports, targets);
    for (const t of targets) {
      // Manifest targets are written both ways ("./src/index.ts" in the
      // packages, "dist/src/index.js" for the root bin/main). Accept both and
      // let path resolution reject anything that is not a real source file.
      if (typeof t !== "string" || t.startsWith("/")) continue;
      // dist/src/index.js -> src/index.ts ; dist/node/lint.js -> src/lint.ts
      const cleaned = t.replace(/^\.\//, "");
      const sourceGuesses = [
        cleaned,
        cleaned.replace(/^dist\/(node|browser)\//, "src/"),
        cleaned.replace(/^dist\//, ""),
      ];
      for (const guess of sourceGuesses) {
        const hit = tryCandidates(treeRoot, `${dir}${guess}`, known);
        if (hit) {
          roots.add(hit);
          break;
        }
      }
    }
  };

  addManifest("package.json");
  const pkgDir = join(treeRoot, "packages");
  if (existsSync(pkgDir)) {
    for (const entry of readdirSync(pkgDir)) {
      if (existsSync(join(pkgDir, entry, "package.json"))) addManifest(`packages/${entry}/package.json`);
    }
  }

  // Top-level scripts are executables in their own right (package.json scripts,
  // .husky hooks). Their own exports are their surface, so they are roots.
  for (const rel of known) {
    if (/^scripts\/[^/]+\.[cm]?tsx?$/.test(rel)) roots.add(rel);
  }

  return roots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

export function analyze(opts: AnalyzeOptions): AnalyzeResult {
  const { treeRoot } = opts;
  const warnings = [...(opts.warnings ?? [])];

  const relFiles: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(treeRoot, dir);
    if (existsSync(abs)) walk(abs, treeRoot, relFiles);
  }
  const known = new Set(relFiles);

  const parsed = new Map<string, ParsedFile>();
  for (const rel of relFiles) {
    try {
      parsed.set(rel, parseSource(rel, readFileSync(join(treeRoot, rel), "utf8")));
    } catch (err) {
      warnings.push(`parse failed: ${rel}`);
      console.error(
        `[export-reachability] parse failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const resolveSpec = makeResolver(treeRoot, known);
  const entryPoints = discoverEntryPoints(treeRoot, known);

  // ── Resolved edge table ──────────────────────────────────────────────────
  interface ResolvedEdge {
    to: string;
    names: Set<string>;
    wildcard: boolean;
    isReExport: boolean;
    locals: Map<string, string>;
    nsLocal?: string;
  }
  const edges = new Map<string, ResolvedEdge[]>();
  for (const [rel, file] of parsed) {
    const list: ResolvedEdge[] = [];
    for (const imp of file.imports) {
      const to = resolveSpec(rel, imp.spec);
      if (!to || !parsed.has(to)) continue;
      list.push({
        to,
        names: imp.names,
        wildcard: imp.wildcard,
        isReExport: imp.isReExport,
        locals: imp.locals,
        nsLocal: imp.nsLocal,
      });
    }
    edges.set(rel, list);
  }

  // ── Star re-export chains: which module actually DECLARES a name ─────────
  const starTargets = new Map<string, string[]>();
  for (const [rel, file] of parsed) {
    starTargets.set(
      rel,
      file.starReExports.map((s) => resolveSpec(rel, s)).filter((x): x is string => !!x && parsed.has(x)),
    );
  }

  const declares = (mod: string, name: string): boolean =>
    (parsed.get(mod)?.exports ?? []).some((e) => e.name === name && !e.reExportedFrom);

  /**
   * Follow `export { x } from "./m"` and `export * from "./m"` so an import of
   * a barrel is attributed to the module that actually declares the symbol.
   */
  const originCache = new Map<string, string[]>();
  function originsOf(mod: string, name: string, seen = new Set<string>()): string[] {
    const key = `${mod}\u0000${name}`;
    const cached = originCache.get(key);
    if (cached) return cached;
    if (seen.has(mod)) return [];
    seen.add(mod);
    const out: string[] = [];
    if (declares(mod, name)) out.push(mod);
    for (const e of parsed.get(mod)?.exports ?? []) {
      if (e.name === name && e.reExportedFrom) {
        const t = resolveSpec(mod, e.reExportedFrom);
        if (t && parsed.has(t)) out.push(...originsOf(t, name, seen));
      }
    }
    for (const t of starTargets.get(mod) ?? []) out.push(...originsOf(t, name, seen));
    const uniq = [...new Set(out)];
    originCache.set(key, uniq);
    return uniq;
  }

  /** Every name a module exposes, following star chains (for wildcard imports). */
  function exposedNames(mod: string, seen = new Set<string>()): Set<string> {
    if (seen.has(mod)) return new Set();
    seen.add(mod);
    const out = new Set<string>();
    for (const e of parsed.get(mod)?.exports ?? []) out.add(e.name);
    for (const t of starTargets.get(mod) ?? []) for (const n of exposedNames(t, seen)) out.add(n);
    return out;
  }

  // ── Public surface: a name republished by a package entry point is API ───
  const publicPairs = new Set<string>(); // `${module}\u0000${name}`
  for (const root of entryPoints) {
    for (const name of exposedNames(root)) {
      for (const origin of originsOf(root, name)) publicPairs.add(`${origin}\u0000${name}`);
    }
  }

  // ── Reachability BFS over production modules ─────────────────────────────
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const root of entryPoints) {
    if (parsed.has(root) && !parsed.get(root)?.isTest) {
      reachable.add(root);
      queue.push(root);
    }
  }
  while (queue.length) {
    const cur = queue.pop() as string;
    for (const edge of edges.get(cur) ?? []) {
      if (parsed.get(edge.to)?.isTest) continue;
      if (reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }

  // ── Who imports (module, name)? ──────────────────────────────────────────
  const prodImporters = new Map<string, Set<string>>();
  const testImporters = new Map<string, Set<string>>();
  const bump = (map: Map<string, Set<string>>, key: string, who: string): void => {
    let s = map.get(key);
    if (!s) {
      s = new Set();
      map.set(key, s);
    }
    s.add(who);
  };

  for (const [rel, list] of edges) {
    const file = parsed.get(rel);
    if (!file) continue;
    // A production importer only counts when IT is reachable from an entry
    // point — otherwise "used" would be satisfiable by another dead module.
    const asProd = !file.isTest && reachable.has(rel);
    const target = file.isTest ? testImporters : asProd ? prodImporters : null;
    if (!target) continue;
    for (const edge of list) {
      // A barrel republishing a name is not a consumer of it. Skipping these
      // closes a one-line laundering path: `export { dead } from "./m"` in a
      // reachable module would otherwise make `dead` look reached.
      if (edge.isReExport) continue;

      if (edge.wildcard) {
        // `import * as ns` counts only when `ns` is actually dereferenced; the
        // clause itself contributes the first occurrence. A dynamic
        // `import("...")` has no stable binding (nsLocal undefined) and is
        // accepted outright rather than risking a false positive.
        if (edge.nsLocal && (file.refCounts.get(edge.nsLocal) ?? 0) < 2) continue;
        for (const name of exposedNames(edge.to)) {
          for (const origin of originsOf(edge.to, name)) {
            if (origin === rel) continue;
            bump(target, `${origin}\u0000${name}`, rel);
          }
        }
        continue;
      }

      for (const name of edge.names) {
        // An imported binding whose ONLY occurrence is the import clause is an
        // unused import. Counting it as a use would let one dead-letter import
        // line satisfy this gate without the symbol ever running.
        const local = edge.locals.get(name) ?? name;
        if ((file.refCounts.get(local) ?? 0) < 2) continue;
        for (const origin of originsOf(edge.to, name)) {
          if (origin === rel) continue;
          bump(target, `${origin}\u0000${name}`, rel);
        }
      }
    }
  }

  // ── Diff scope ───────────────────────────────────────────────────────────
  const changed = new Set(opts.changedFiles ?? []);
  const baselineSources = opts.baselineSources ?? new Map<string, string>();

  /** Names exported by a file BEFORE the change. */
  function baselineExports(rel: string): Set<string> {
    const text = baselineSources.get(rel);
    if (text === undefined) return new Set(); // new file → every export is added
    try {
      return new Set(parseSource(rel, text).exports.map((e) => e.name));
    } catch (err) {
      console.error(
        `[export-reachability] baseline parse failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
      );
      warnings.push(`baseline parse failed: ${rel}`);
      return new Set();
    }
  }

  // ── Shadow-twin lookup: name -> modules already exporting it ─────────────
  const exportedBy = new Map<string, string[]>();
  for (const [rel, file] of parsed) {
    if (file.isTest) continue;
    for (const e of file.exports) {
      if (e.isType || e.reExportedFrom) continue;
      const list = exportedBy.get(e.name) ?? [];
      list.push(rel);
      exportedBy.set(e.name, list);
    }
  }

  // ── Candidate selection + verdict ────────────────────────────────────────
  const findings: Finding[] = [];
  let candidates = 0;

  const modulesToCheck = opts.all ? [...parsed.keys()] : [...changed].filter((f) => parsed.has(f));

  for (const rel of modulesToCheck) {
    const file = parsed.get(rel);
    if (!file || file.isTest) continue;
    // An entry point IS the surface — its own exports have no internal caller
    // by design (src/index.ts, scripts/*.ts, packages' public-api files).
    if (entryPoints.has(rel)) continue;

    const before = opts.all ? new Set<string>() : baselineExports(rel);

    for (const e of file.exports) {
      if (e.isType) continue; // types carry no runtime behaviour
      if (e.reExportedFrom) continue; // declared elsewhere; checked at its origin
      if (e.name === "default") continue; // default exports are consumed positionally
      if (!opts.all && before.has(e.name)) continue; // not new

      candidates++;
      const key = `${rel}\u0000${e.name}`;
      if (publicPairs.has(key)) continue; // published package API

      const prod = prodImporters.get(key);
      if (prod && prod.size > 0) continue;

      // Used elsewhere inside its own declaring module, and that module is on
      // a live path → the symbol is reached.
      if (reachable.has(rel) && (file.refCounts.get(e.name) ?? 0) > 0) continue;

      const tests = [...(testImporters.get(key) ?? [])].sort();
      const kind: Finding["kind"] = tests.length > 0 ? "test-only" : "dead";

      // A declared test seam is a legitimate observation window onto live
      // module state — the test still exercises shipped code through the
      // normal API. It exempts "test-only" only: a symbol NOTHING imports
      // cannot be a seam, so exp-3's shape stays un-exemptable.
      if (kind === "test-only" && e.testSeamMarked) continue;

      const twin = (exportedBy.get(e.name) ?? []).find((m) => m !== rel);

      findings.push({
        file: rel,
        line: e.line,
        symbol: e.name,
        kind,
        testImporters: tests,
        ...(twin ? { shadowsExistingExport: twin } : {}),
      });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    findings,
    stats: {
      filesScanned: parsed.size,
      reachableModules: reachable.size,
      entryPoints: entryPoints.size,
      changedFiles: changed.size,
      candidates,
      baseline: opts.baselineLabel ?? null,
      warnings,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// git plumbing
// ─────────────────────────────────────────────────────────────────────────────

function git(repoRoot: string, args: string[]): string {
  // stderr is PIPED, not inherited: `git show <base>:<path>` legitimately fails
  // for every file the change ADDED, and an inherited "fatal:" line would make
  // a healthy run look broken.
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Resolve the baseline the change is measured against.
 *
 * On a feature branch the meaningful baseline is the branch point, so work the
 * sprint already COMMITTED is still in scope; on the default branch that
 * collapses to HEAD, i.e. uncommitted work only. Both are covered by a single
 * `git diff <base>` (base → working tree).
 */
export function resolveBaseline(repoRoot: string, explicit?: string): { ref: string | null; warnings: string[] } {
  const warnings: string[] = [];
  if (explicit) return { ref: explicit, warnings };
  for (const candidate of ["origin/develop", "develop", "origin/master", "master"]) {
    try {
      const base = git(repoRoot, ["merge-base", "HEAD", candidate]).trim();
      if (base) return { ref: base, warnings };
    } catch (err) {
      // Probing candidate refs in order: a miss is control flow, not a fault
      // (a clone with no `origin/develop` is normal). Recorded as a warning
      // rather than logged to stderr — every warning is printed by the CLI and
      // carried in `stats.warnings`, so which baseline was chosen, and why the
      // earlier candidates lost, is never invisible.
      warnings.push(
        `merge-base against ${candidate} unavailable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }
  try {
    return { ref: git(repoRoot, ["rev-parse", "HEAD"]).trim(), warnings };
  } catch (err) {
    console.error(
      `[export-reachability] git rev-parse HEAD failed in ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    warnings.push("git unavailable — diff scope could not be computed");
    return { ref: null, warnings };
  }
}

export function changedFilesSince(repoRoot: string, base: string): string[] {
  const out = git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMR", base]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => SOURCE_EXT.test(l) && !l.endsWith(".d.ts"));
}

export function changedFilesInCommit(repoRoot: string, rev: string): string[] {
  const out = git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMR", `${rev}^`, rev]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => SOURCE_EXT.test(l) && !l.endsWith(".d.ts"));
}

/** True when `rev` names an object present in this clone. */
export function revExists(repoRoot: string, rev: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`]);
    return true;
  } catch (err) {
    console.error(
      `[export-reachability] rev ${rev} not present in ${repoRoot}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
    return false;
  }
}

/**
 * Materialise a git revision into a temp dir — no worktree, no repo mutation,
 * and no shell, so it behaves identically from PowerShell and from bash.
 * The caller owns the returned directory and must remove it.
 */
export function extractRevision(repoRoot: string, rev: string): string {
  const dir = mkdtempSync(join(tmpdir(), "export-reach-"));
  const tarball = join(dir, "__rev.tar");
  execFileSync(
    "git",
    ["archive", "--format=tar", "-o", tarball, rev, "src", "scripts", "packages", "tests", "package.json"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  // GNU tar (the build Git for Windows ships) reads `C:\…` as a remote host,
  // so extract from inside the directory with a relative name instead of -C.
  execFileSync("tar", ["-xf", "__rev.tar"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  rmSync(tarball, { force: true });
  return dir;
}

/** Analyse one commit against its first parent. */
export function analyzeRevision(repoRoot: string, rev: string): AnalyzeResult {
  const dir = extractRevision(repoRoot, rev);
  try {
    const changedFiles = changedFilesInCommit(repoRoot, rev);
    return analyze({
      treeRoot: dir,
      changedFiles,
      baselineSources: readBaselineSources(repoRoot, `${rev}^`, changedFiles),
      baselineLabel: `${rev}^..${rev}`,
    });
  } finally {
    // DECISION (Defect 3, site 9/10): log, retry, and NEVER throw from here.
    //
    // Same `finally` hazard as install-manager: a throw here REPLACES the
    // `analyze(...)` return value, so a transient ENOTEMPTY on the extracted
    // revision tree would surface as the reachability analysis itself failing.
    // This runs in the pre-push / CI gate, where that reads as "the gate found
    // unreachable exports" — a wrong verdict on a clean tree, which is exactly
    // the misclassification shape f3fa174e was written to stop.
    //
    // Non-fatal but logged: `dir` is a scratch extraction under tmp, so a leftover
    // costs disk, not correctness — but a repeated leak on a gate that runs on
    // every push should be visible. Retries are on; the writer here is git's own
    // extraction, already finished, so ENOTEMPTY is the plausible mode.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(
        `[export-reachability] extracted-revision cleanup failed (${dir}); a scratch tree is left behind: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
  }
}

export function readBaselineSources(repoRoot: string, ref: string, files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    try {
      map.set(f, git(repoRoot, ["show", `${ref}:${f}`]));
    } catch (err) {
      // A file ADDED by the change is absent from the baseline, so this failure
      // is the normal path, not an error. git's own text lands in `stderr` on
      // bun/node, so both fields are inspected before deciding it is unexpected.
      const e = err as { message?: string; stderr?: unknown };
      const detail = `${e?.message ?? String(err)}\n${typeof e?.stderr === "string" ? e.stderr : ""}`;
      const expected = /does not exist|exists on disk, but not in|unknown revision|invalid object name|fatal: path/i;
      if (!expected.test(detail)) {
        console.error(`[export-reachability] git show ${ref}:${f} failed unexpectedly: ${detail.split("\n")[0]}`);
      }
    }
  }
  return map;
}
