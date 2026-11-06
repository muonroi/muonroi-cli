/**
 * scripts/check-hardcoded-ids.ts
 *
 * Zero Hardcode Rule (AGENTS.md / CLAUDE.md) for THIS repository: production
 * code must not spell a model ID or a provider ID as a string literal — they
 * come from src/models/catalog.json, user settings and runtime detection.
 *
 * This used to be prose in the product prompt sent to every user of the CLI,
 * which is project knowledge of muonroi-cli leaking into other people's
 * sessions. The rule belongs to this repo, so it is enforced here instead.
 *
 * The forbidden set is DERIVED, never typed in: every `models[].id` and
 * `models[].provider` in catalog.json, plus the members of the `ProviderId`
 * union in src/providers/types.ts.
 *
 * Allowed by the rule (skipped):
 *   - catalog.json itself (not scanned: only .ts/.tsx are)
 *   - type definitions (`type X = "a" | "b"` and `| "b"` continuation lines)
 *   - tests and fixtures (*.test.*, *.spec.*, __tests__/, __test-utils__/)
 *   - src/providers/pricing.ts (static reference pricing table)
 *   - comments
 *
 * Existing literals are a ratchet baseline in scripts/.hardcoded-ids-allow.json
 * ({ file: { literal: count } }). A file that gains a literal, or a new file
 * with one, is a violation. Counts that drop are reported so the baseline can
 * be tightened with --update.
 *
 * Usage:
 *   bun scripts/check-hardcoded-ids.ts            # report, exit 0
 *   bun scripts/check-hardcoded-ids.ts --strict   # CI: exit 1 on a new literal
 *   bun scripts/check-hardcoded-ids.ts --update   # rewrite the baseline
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Hit {
  file: string;
  line: number;
  literal: string;
}

export type Baseline = Record<string, Record<string, number>>;

const ALLOWED_FILES = new Set(["src/providers/pricing.ts"]);

export function isExemptPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  if (ALLOWED_FILES.has(p)) return true;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return true;
  if (/(^|\/)(__tests__|__test-utils__|__fixtures__|fixtures)\//.test(p)) return true;
  return !/\.[cm]?tsx?$/.test(p) || p.endsWith(".d.ts");
}

/** Forbidden literals, derived from the catalog and the ProviderId union. */
export function loadForbiddenIds(repoRoot: string): Set<string> {
  const ids = new Set<string>();
  const catalog = JSON.parse(readFileSync(join(repoRoot, "src/models/catalog.json"), "utf8")) as {
    models?: Array<{ id?: unknown; provider?: unknown }>;
  };
  for (const row of catalog.models ?? []) {
    if (typeof row.id === "string" && row.id) ids.add(row.id);
    if (typeof row.provider === "string" && row.provider) ids.add(row.provider);
  }
  const types = readFileSync(join(repoRoot, "src/providers/types.ts"), "utf8");
  const union = /export\s+type\s+ProviderId\s*=([^;]+);/.exec(types);
  if (!union) throw new Error("check-hardcoded-ids: ProviderId union not found in src/providers/types.ts");
  for (const m of union[1]!.matchAll(/"([^"]+)"/g)) ids.add(m[1]!);
  return ids;
}

/**
 * Collect string-literal contents with their line numbers, skipping comments.
 * A minimal lexer: quotes cannot span a newline (JS forbids it), so a regex
 * literal containing a quote can confuse at most the rest of its own line.
 */
export function stringLiterals(src: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let line = 1;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const startLine = line;
      let text = "";
      let interpolated = false;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          text += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "\n") {
          if (quote !== "`") break;
          line++;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") interpolated = true;
        text += src[i];
        i++;
      }
      i++;
      if (!interpolated) out.push({ text, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

function isTypeDefinitionLine(lineText: string): boolean {
  return /^\s*(export\s+)?(declare\s+)?type\s+\w+/.test(lineText) || /^\s*\|\s*["'`]/.test(lineText);
}

export function scanSource(rel: string, src: string, forbidden: ReadonlySet<string>): Hit[] {
  const lines = src.split(/\r?\n/);
  const hits: Hit[] = [];
  for (const lit of stringLiterals(src)) {
    if (!forbidden.has(lit.text)) continue;
    if (isTypeDefinitionLine(lines[lit.line - 1] ?? "")) continue;
    hits.push({ file: rel, line: lit.line, literal: lit.text });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else out.push(full);
  }
  return out;
}

export function countByFile(hits: readonly Hit[]): Baseline {
  const counts: Baseline = {};
  for (const h of hits) {
    const perFile = (counts[h.file] ??= {});
    perFile[h.literal] = (perFile[h.literal] ?? 0) + 1;
  }
  return counts;
}

/** Hits beyond the baseline (new file, new literal, or a higher count). */
export function compareToBaseline(hits: readonly Hit[], baseline: Baseline): { violations: Hit[]; improved: string[] } {
  const counts = countByFile(hits);
  const violations: Hit[] = [];
  for (const [file, literals] of Object.entries(counts)) {
    for (const [literal, count] of Object.entries(literals)) {
      const allowed = baseline[file]?.[literal] ?? 0;
      if (count > allowed) violations.push(...hits.filter((h) => h.file === file && h.literal === literal));
    }
  }
  const improved: string[] = [];
  for (const [file, literals] of Object.entries(baseline)) {
    for (const [literal, allowed] of Object.entries(literals)) {
      const now = counts[file]?.[literal] ?? 0;
      if (now < allowed) improved.push(`${file} "${literal}": ${allowed} -> ${now}`);
    }
  }
  return { violations, improved };
}

export function scanRepo(repoRoot: string): Hit[] {
  const forbidden = loadForbiddenIds(repoRoot);
  const hits: Hit[] = [];
  for (const full of walk(join(repoRoot, "src"))) {
    const rel = relative(repoRoot, full).replace(/\\/g, "/");
    if (isExemptPath(rel)) continue;
    hits.push(...scanSource(rel, readFileSync(full, "utf8"), forbidden));
  }
  return hits;
}

function main(): void {
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const allowFile = join(repoRoot, "scripts", ".hardcoded-ids-allow.json");
  const strict = process.argv.includes("--strict");
  const update = process.argv.includes("--update");
  const hits = scanRepo(repoRoot);
  if (update) {
    const sorted = Object.fromEntries(Object.entries(countByFile(hits)).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(allowFile, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(
      `[check-hardcoded-ids] baseline written: ${hits.length} literal(s) in ${Object.keys(sorted).length} file(s)`,
    );
    return;
  }
  const baseline: Baseline = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : {};
  const { violations, improved } = compareToBaseline(hits, baseline);
  console.log(`[check-hardcoded-ids] ${hits.length} model/provider ID literal(s) in src (baseline-tracked).`);
  for (const line of improved) console.log(`  improved (run --update to tighten): ${line}`);
  if (violations.length === 0) {
    console.log("[check-hardcoded-ids] OK — no new hardcoded model/provider IDs.");
    return;
  }
  console.error(
    `[check-hardcoded-ids] ${violations.length} new hardcoded model/provider ID literal(s). Resolve from catalog.json, settings (getCurrentModel/getDefaultProvider) or runtime detection (detectProviderForModel) and throw when unresolvable:`,
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  "${v.literal}"`);
  if (strict) process.exit(1);
}

if (import.meta.main) main();
