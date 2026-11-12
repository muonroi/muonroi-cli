/**
 * src/workflow/fidelity-probe.ts
 *
 * Host-run fidelity probe for conversion/transformation goals ("convert doc.html
 * into markdown docs"). Every gate in session 26516fe0c62e measured PROCESS
 * counts (headings, fences, macro leaks) and none compared the output text with
 * the source: the run passed verify with 274 literal `\_` escapes (tenant\_id)
 * and ~12 `&lt;`/`&gt;` inside code spans.
 *
 * Two deterministic checks, both bounded by size caps (no model, no randomness):
 *   1. Passage coverage: N evenly-spaced passages of the SOURCE text (markup
 *      stripped, entities decoded, whitespace folded) must appear in the
 *      normalized concatenation of the OUTPUT files.
 *   2. Escape residue: literal `\_`, `\*`, `&lt;`, `&gt;`, `&amp;` in the output
 *      beyond what the source text itself contains.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_PROBE_BYTES = 5 * 1024 * 1024;
export const PROBE_SAMPLE_COUNT = 25;
/** Chars of each passage that must be found; a long paragraph may be re-wrapped after its head. */
export const PASSAGE_HEAD_CHARS = 120;
const MIN_PASSAGE_CHARS = 30;
const MAX_EXAMPLES = 5;
/** Below this found/sampled ratio the probe fails (Confluence chrome legitimately drops some text). */
export const MIN_COVERAGE = 0.5;

export type ResidueKind = "\\_" | "\\*" | "&lt;" | "&gt;" | "&amp;";
const RESIDUE: ReadonlyArray<{ kind: ResidueKind; re: RegExp }> = [
  { kind: "\\_", re: /\\_/g },
  { kind: "\\*", re: /\\\*/g },
  { kind: "&lt;", re: /&lt;/gi },
  { kind: "&gt;", re: /&gt;/gi },
  { kind: "&amp;", re: /&amp;/gi },
];

export interface ResidueFinding {
  kind: ResidueKind;
  /** Occurrences in the output files. */
  outputCount: number;
  /** Occurrences the decoded source text itself contains (allowed). */
  sourceCount: number;
  /** Of the excess, how many sit inside code spans / fences. */
  inCode: number;
  examples: string[];
}

export interface FidelityResult {
  source: string;
  outputs: string[];
  sampled: number;
  found: number;
  missing: string[];
  residue: ResidueFinding[];
  /** Empty when the probe passes; otherwise one named reason per failed check. */
  failures: string[];
  /** Why no verdict was possible (size cap, unreadable file); failures stay empty. */
  skipped?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Visible text of an HTML document, one block per line. Linear: no nested-quantifier regexes. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|pre|blockquote|section|article|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(stripped);
}

/** Source file -> text. HTML/XML are stripped; md/txt are read as they are. */
export function sourceText(file: string, raw: string): string {
  return /\.(?:html?|xml|xhtml)$/i.test(file) ? htmlToText(raw) : raw;
}

/** Fold markdown/typography so a passage compares on words only. */
export function normalizeForCompare(text: string): string {
  return decodeEntities(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/[`*_#>|~]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Deterministic, evenly spaced passages (one per source line with enough text). */
export function samplePassages(text: string, count = PROBE_SAMPLE_COUNT): string[] {
  const lines = text
    .split(/\n+/)
    .map((l) => normalizeForCompare(l))
    .filter((l) => l.length >= MIN_PASSAGE_CHARS && l.split(" ").length >= 5);
  if (lines.length <= count) return lines.map((l) => l.slice(0, PASSAGE_HEAD_CHARS));
  const picked: string[] = [];
  for (let i = 0; i < count; i++)
    picked.push(lines[Math.floor((i * lines.length) / count)]!.slice(0, PASSAGE_HEAD_CHARS));
  return picked;
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Occurrences of `re` inside fenced blocks and inline code spans of markdown `md`. */
function countInCode(md: string, re: RegExp): { total: number; examples: string[] } {
  const spans: string[] = [];
  const withoutFences = md.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, (block) => {
    spans.push(block);
    return "\n";
  });
  for (const m of withoutFences.matchAll(/`[^`\n]+`/g)) spans.push(m[0]);
  let total = 0;
  const examples: string[] = [];
  for (const span of spans) {
    const n = countMatches(span, re);
    total += n;
    if (n && examples.length < MAX_EXAMPLES) examples.push(span.replace(/\s+/g, " ").slice(0, 100));
  }
  return { total, examples };
}

function readCapped(file: string): { text: string } | { skipped: string } {
  try {
    if (!existsSync(file)) return { skipped: `${file} does not exist` };
    const size = statSync(file).size;
    if (size > MAX_PROBE_BYTES)
      return { skipped: `${file} is ${size} bytes, over the ${MAX_PROBE_BYTES} byte probe cap` };
    return { text: readFileSync(file, "utf8") };
  } catch (err) {
    console.error(`[fidelity-probe] cannot read ${file}: ${(err as Error).message}`);
    return { skipped: `${file} unreadable: ${(err as Error).message}` };
  }
}

/**
 * Compare `outputs` against `source`. Never throws; an unreadable or oversized
 * input yields `skipped` with no failures (the probe could not decide).
 */
export function runFidelityProbe(source: string, outputs: readonly string[], cwd: string): FidelityResult {
  const rel = (f: string) => path.relative(cwd, f).split(path.sep).join("/") || f;
  const result: FidelityResult = {
    source: rel(source),
    outputs: outputs.map(rel),
    sampled: 0,
    found: 0,
    missing: [],
    residue: [],
    failures: [],
  };
  const src = readCapped(source);
  if ("skipped" in src) return { ...result, skipped: src.skipped };
  let total = 0;
  const texts: string[] = [];
  for (const out of outputs) {
    const read = readCapped(out);
    if ("skipped" in read) return { ...result, skipped: read.skipped };
    total += read.text.length;
    if (total > MAX_PROBE_BYTES) return { ...result, skipped: `outputs exceed the ${MAX_PROBE_BYTES} byte probe cap` };
    texts.push(read.text);
  }
  const output = texts.join("\n");
  const plain = sourceText(source, src.text);

  const haystack = normalizeForCompare(output);
  const passages = samplePassages(plain);
  result.sampled = passages.length;
  for (const p of passages) {
    if (haystack.includes(p)) result.found++;
    else if (result.missing.length < MAX_EXAMPLES) result.missing.push(p);
  }
  if (result.sampled > 0 && result.found / result.sampled < MIN_COVERAGE)
    result.failures.push(
      `only ${result.found} of ${result.sampled} sampled source passages appear in the output (needs at least ${Math.ceil(result.sampled * MIN_COVERAGE)}); first missing: ${result.missing
        .slice(0, 2)
        .map((m) => JSON.stringify(m.slice(0, 80)))
        .join(", ")}`,
    );

  for (const { kind, re } of RESIDUE) {
    const outputCount = countMatches(output, re);
    const sourceCount = countMatches(plain, re);
    if (outputCount <= sourceCount) continue;
    const code = countInCode(output, re);
    const examples = [...output.matchAll(new RegExp(re.source, re.flags))]
      .slice(0, MAX_EXAMPLES)
      .map((m) => output.slice(Math.max(0, m.index - 20), m.index + 20).replace(/\s+/g, " "));
    result.residue.push({ kind, outputCount, sourceCount, inCode: code.total, examples });
    result.failures.push(
      `${outputCount - sourceCount} literal ${kind} escape(s) in the output that the source text does not contain (${code.total} inside code spans/fences); e.g. ${JSON.stringify(examples[0] ?? "")}`,
    );
  }
  return result;
}

/** Evidence block for the verify council: counts and first examples. */
export function renderFidelityEvidence(r: FidelityResult): string {
  const lines = [`- source ${r.source} -> ${r.outputs.length} output file(s): ${r.outputs.slice(0, 8).join(", ")}`];
  if (r.skipped) return [...lines, `  probe skipped: ${r.skipped}`].join("\n");
  lines.push(`  passage coverage: ${r.found}/${r.sampled} sampled source passages found in the output`);
  for (const m of r.missing.slice(0, 3)) lines.push(`  missing: ${JSON.stringify(m.slice(0, 100))}`);
  if (!r.residue.length) lines.push("  escape residue: none beyond the source's own text");
  for (const f of r.residue)
    lines.push(
      `  escape residue ${f.kind}: output ${f.outputCount} vs source ${f.sourceCount} (${f.inCode} inside code); e.g. ${JSON.stringify(f.examples[0] ?? "")}`,
    );
  lines.push(`  fidelity probe: ${r.failures.length ? "FAIL" : "pass"}`);
  return lines.join("\n");
}
