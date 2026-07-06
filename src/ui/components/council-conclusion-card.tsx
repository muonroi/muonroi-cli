import { dark } from "../theme.js";

/**
 * Structured post-debate conclusion, parsed from the leader synthesis JSON.
 *
 * When a debate's deliverable is an evaluation/decision, the synthesizer emits a
 * JSON object (summary + strengths/weaknesses/recommendation/coverage_matrix …).
 * Rendered verbatim (the old CouncilSynthesisBanner path) it reads as an unbroken
 * wall of JSON — "freetext khó nhìn". This card lifts the known sections into a
 * scannable layout. When the text is NOT parseable structured JSON (e.g. the
 * synthesizer emitted a `---READABLE---` prose tail), `parseConclusion` returns
 * null and the caller falls back to plain-text rendering.
 */

export interface ParsedConclusion {
  summary?: string;
  recommendation?: string;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  tradeoffs: string[];
  /** Generic rows: each row is a list of its string cell values, best-effort. */
  coverage: string[][];
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return undefined;
}

function firstArray(obj: Record<string, unknown>, keys: string[]): string[] {
  for (const k of keys) {
    const arr = asStringArray(obj[k]);
    if (arr.length > 0) return arr;
  }
  return [];
}

function coverageRows(obj: Record<string, unknown>): string[][] {
  for (const k of ["coverage_matrix", "coverage", "criteria", "coverageMatrix"]) {
    const raw = obj[k];
    if (!Array.isArray(raw)) continue;
    const rows: string[][] = [];
    for (const item of raw) {
      if (item && typeof item === "object") {
        const cells = Object.values(item as Record<string, unknown>)
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim());
        if (cells.length > 0) rows.push(cells);
      } else if (typeof item === "string" && item.trim().length > 0) {
        rows.push([item.trim()]);
      }
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * Best-effort parse of a synthesis body into a structured conclusion. Returns
 * null when the text is not a JSON object with at least one recognizable section
 * — the caller then renders it as plain text.
 */
export function parseConclusion(text: string): ParsedConclusion | null {
  const trimmed = text.trim();
  // A `---READABLE---` prose tail means the synthesizer already produced human
  // copy; don't try to structure it — let the plain-text path render the prose.
  if (trimmed.includes("---READABLE---")) return null;

  // Strip a leading ```json … ``` fence if present, then isolate the object.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    // Not structured JSON — plain-text fallback handles it. No log: this is an
    // expected branch for prose syntheses, not an error.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const summary = firstString(parsed, ["summary", "conclusion"]);
  const recommendation = firstString(parsed, ["recommendation", "decision", "verdict"]);
  const strengths = firstArray(parsed, ["strengths", "pros", "agreed"]);
  const weaknesses = firstArray(parsed, ["weaknesses", "cons", "gaps"]);
  const risks = firstArray(parsed, ["risks", "concerns"]);
  const tradeoffs = firstArray(parsed, ["tradeoffs", "trade_offs", "trade-offs"]);
  const coverage = coverageRows(parsed);

  const hasContent =
    !!summary ||
    !!recommendation ||
    strengths.length > 0 ||
    weaknesses.length > 0 ||
    risks.length > 0 ||
    tradeoffs.length > 0 ||
    coverage.length > 0;
  if (!hasContent) return null;

  return { summary, recommendation, strengths, weaknesses, risks, tradeoffs, coverage };
}

interface BulletSectionProps {
  title: string;
  items: string[];
  color: string;
}

function BulletSection({ title, items, color }: BulletSectionProps) {
  if (items.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={color} attributes={1}>
        {title}
      </text>
      {items.map((it, i) => (
        <box key={`${title}-${i}`} flexDirection="row">
          <text fg={dark.textMuted}>{"  • "}</text>
          <text fg={dark.text}>{it}</text>
        </box>
      ))}
    </box>
  );
}

export interface CouncilConclusionCardProps {
  conclusion: ParsedConclusion;
  /** Round number for a per-round synthesis; undefined = final synthesis. */
  round?: number;
}

export function CouncilConclusionCard({ conclusion, round }: CouncilConclusionCardProps) {
  const title = round === undefined ? "Final Conclusion" : `Round ${round} Conclusion`;
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={dark.councilSynthesisBorder}
      paddingLeft={2}
    >
      <text fg={dark.councilSynthesisBorder} attributes={1}>
        {title}
      </text>
      {conclusion.summary && <text fg={dark.text}>{conclusion.summary}</text>}
      {conclusion.recommendation && (
        <box flexDirection="column" marginTop={1}>
          <text fg={dark.accent} attributes={1}>
            Recommendation
          </text>
          <text fg={dark.text}>{conclusion.recommendation}</text>
        </box>
      )}
      <BulletSection title="Strengths" items={conclusion.strengths} color={dark.diffAddedFg} />
      <BulletSection title="Weaknesses" items={conclusion.weaknesses} color={dark.diffRemovedFg} />
      <BulletSection title="Risks" items={conclusion.risks} color={dark.diffRemovedFg} />
      <BulletSection title="Trade-offs" items={conclusion.tradeoffs} color={dark.mdItalic} />
      {conclusion.coverage.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={dark.textMuted} attributes={1}>
            Coverage
          </text>
          {conclusion.coverage.map((row, i) => (
            <box key={`cov-${i}`} flexDirection="row">
              <text fg={dark.textMuted}>{"  – "}</text>
              <text fg={dark.text}>{row.join(" · ")}</text>
            </box>
          ))}
        </box>
      )}
    </box>
  );
}
