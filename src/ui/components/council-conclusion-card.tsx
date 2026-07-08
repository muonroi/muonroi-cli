import type { Theme } from "../theme.js";

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

export interface DimensionScore {
  dimension: string;
  score: number;
  justification: string;
}

export interface OperationalRisk {
  risk: string;
  severity: string;
  trigger: string;
}

export interface NextAction {
  action: string;
  label: string;
  reason?: string;
}

export interface ParsedConclusion {
  summary?: string;
  recommendation?: string;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  tradeoffs: string[];
  dimensionScores: DimensionScore[];
  operationalRisks: OperationalRisk[];
  priorityFixes: string[];
  nextActions: NextAction[];
  /** Generic rows: each row is a list of its string cell values, best-effort. */
  coverage: string[][];
  /** Leftover top-level keys (implementation_plan etc.) as generic titled sections. */
  sections: Array<{ title: string; items: string[] }>;
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

function parseDimensionScores(obj: Record<string, unknown>): DimensionScore[] {
  const raw = obj.dimension_scores ?? obj.dimensionScores ?? obj.scores;
  if (!Array.isArray(raw)) return [];
  const out: DimensionScore[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const dimension = String(row.dimension ?? row.name ?? row.criteria ?? "").trim();
    const scoreRaw = row.score ?? row.rating ?? row.value;
    const score = typeof scoreRaw === "number" ? scoreRaw : Number.parseInt(String(scoreRaw), 10);
    const justification = String(row.justification ?? row.reason ?? row.note ?? "").trim();
    if (dimension && Number.isFinite(score)) {
      out.push({ dimension, score, justification: justification || "(no justification)" });
    }
  }
  return out;
}

function parseOperationalRisks(obj: Record<string, unknown>): OperationalRisk[] {
  const raw = obj.operational_risks ?? obj.operationalRisks ?? obj.risks;
  if (!Array.isArray(raw)) return [];
  const out: OperationalRisk[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const risk = String(row.risk ?? row.name ?? row.title ?? "").trim();
    const severity = String(row.severity ?? row.level ?? row.impact ?? "").trim();
    const trigger = String(row.trigger ?? row.when ?? row.condition ?? "").trim();
    if (risk) {
      out.push({ risk, severity: severity || "Unknown", trigger: trigger || "(not specified)" });
    }
  }
  return out;
}

function parsePriorityFixes(obj: Record<string, unknown>): string[] {
  const raw = obj.priority_fixes ?? obj.priorityFixes ?? obj.fixes ?? obj.action_items;
  if (Array.isArray(raw)) {
    const strings = asStringArray(raw);
    if (strings.length > 0) return strings;
    const flat: string[] = [];
    for (const item of raw) {
      if (item && typeof item === "object") {
        const cells = Object.entries(item as Record<string, unknown>)
          .filter(([, cv]) => cv !== null && cv !== undefined && typeof cv !== "object")
          .map(([ck, cv]) => `${ck}: ${String(cv)}`);
        if (cells.length > 0) flat.push(cells.join(" · "));
      }
    }
    if (flat.length > 0) return flat;
  }
  return [];
}

function parseNextActions(obj: Record<string, unknown>): NextAction[] {
  const raw = obj.nextActions ?? obj.next_actions ?? obj.actions;
  if (!Array.isArray(raw)) return [];
  const out: NextAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const action = String(row.action ?? row.id ?? row.key ?? "").trim();
    const label = String(row.label ?? row.title ?? row.summary ?? action).trim();
    const reason = String(row.reason ?? row.why ?? row.explanation ?? "").trim();
    if (label) {
      out.push({ action: action || label, label, reason: reason || undefined });
    }
  }
  return out;
}

/**
 * Best-effort parse of possibly-truncated JSON. Providers cut synthesis output
 * at maxTokens mid-array (live-verified 2026-07-06: `"nextActions":[…"action":"ask`),
 * which made the whole conclusion fall back to a raw-JSON text wall.
 *
 * Single scan tracking string/escape state and the open-bracket stack. A "safe
 * point" is the index AFTER a complete VALUE (string close, bracket close, or a
 * number/true/false/null character). A closed string is only tentatively safe:
 * if the next structural char is `:` it was a KEY, so we roll back to the
 * previous safe point (otherwise the cut would produce a dangling `{"key"` —
 * invalid JSON). The bracket stack is snapshotted at each safe point so the
 * appended closers match the cut position, not the ragged end.
 */
export function salvageJson(body: string): Record<string, unknown> | null {
  try {
    const direct = JSON.parse(body) as unknown;
    return direct && typeof direct === "object" && !Array.isArray(direct) ? (direct as Record<string, unknown>) : null;
  } catch {
    // fall through to salvage — expected branch for truncated output
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  let stackAtSafe: string[] = [];
  let prevSafe = -1;
  let stackAtPrevSafe: string[] = [];
  let lastStringEnd = -1; // safe point created by the most recent string close
  const markSafe = (endExclusive: number) => {
    if (endExclusive === lastSafe) return;
    prevSafe = lastSafe;
    stackAtPrevSafe = stackAtSafe;
    lastSafe = endExclusive;
    stackAtSafe = stack.slice();
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        markSafe(i + 1);
        lastStringEnd = i + 1;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      markSafe(i + 1);
    } else if (ch === ":") {
      // The string that just closed was a key, not a value — retract it.
      if (lastSafe === lastStringEnd && prevSafe !== -1) {
        lastSafe = prevSafe;
        stackAtSafe = stackAtPrevSafe;
      }
    } else if (/[0-9el]/.test(ch)) {
      // Number / true / false / null terminal characters (outside strings,
      // JSON only allows literals here) — cheap approximation of a value end.
      markSafe(i + 1);
    }
  }
  if (lastSafe <= 0) return null;

  const prefix = body.slice(0, lastSafe).replace(/,\s*$/, "") + stackAtSafe.reverse().join("");
  try {
    const parsed = JSON.parse(prefix) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // salvage failed — caller renders plain text; expected for hopeless input
    return null;
  }
}

/** "agreed_architecture" → "Agreed Architecture"; "actionItems" → "Action Items". */
function titleCase(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Keys never worth a generic section: routing/meta fields. */
const NOISE_KEYS = new Set([
  "type",
  "nextActions",
  "next_actions",
  "sections",
  "kind",
  "dimension_scores",
  "dimensionScores",
  "dimensions",
  "operational_risks",
  "operationalRisks",
  "risk_matrix",
  "priority_fixes",
  "priorityFixes",
  "fixes",
  "action_items",
]);

/** Color a numeric score (1-5) by quality tier. */
function scoreColor(score: number, theme: Theme): string {
  if (score <= 2) return theme.diffRemovedFg;
  if (score === 3) return theme.mdItalic;
  return theme.diffAddedFg;
}

function severityColor(severity: string, theme: Theme): string {
  const s = severity.toLowerCase();
  if (s.includes("critical") || s.includes("high")) return theme.diffRemovedFg;
  if (s.includes("medium") || s.includes("moderate")) return theme.mdItalic;
  return theme.diffAddedFg;
}

/** Compact ASCII bar for a 1-5 score: e.g. "[###  ]". */
function scoreBar(score: number): string {
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  const filled = "#".repeat(clamped);
  const empty = " ".repeat(5 - clamped);
  return `[${filled}${empty}]`;
}

/** Flatten one unknown top-level value into displayable bullet items. */
function flattenValue(v: unknown): string[] {
  if (typeof v === "string") return v.trim().length > 0 ? [v.trim()] : [];
  if (Array.isArray(v)) {
    const items: string[] = [];
    for (const el of v) {
      if (typeof el === "string" && el.trim().length > 0) items.push(el.trim());
      else if (el && typeof el === "object") {
        const cells = Object.entries(el as Record<string, unknown>)
          .filter(([, cv]) => cv !== null && cv !== undefined && typeof cv !== "object")
          .map(([ck, cv]) => `${ck}: ${String(cv)}`);
        if (cells.length > 0) items.push(cells.join(" · "));
      }
    }
    return items;
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
  if (start === -1) return null;
  const end = body.lastIndexOf("}");
  // Truncated output may have NO balanced end — hand the raw tail to salvage.
  const candidate = end > start ? body.slice(start, end + 1) : body.slice(start);

  const parsed = salvageJson(candidate) ?? (end > start ? salvageJson(body.slice(start)) : null);
  if (!parsed) return null;

  const summary = firstString(parsed, ["summary", "conclusion"]);
  const recommendation = firstString(parsed, ["recommendation", "decision", "verdict"]);
  const strengths = firstArray(parsed, ["strengths", "pros", "agreed"]);
  const weaknesses = firstArray(parsed, ["weaknesses", "cons", "gaps"]);
  const risks = firstArray(parsed, ["risks", "concerns"]);
  const tradeoffs = firstArray(parsed, ["tradeoffs", "trade_offs", "trade-offs"]);
  const coverage = coverageRows(parsed);
  const dimensionScores = parseDimensionScores(parsed);
  const operationalRisks = parseOperationalRisks(parsed);
  const priorityFixes = parsePriorityFixes(parsed);
  const nextActions = parseNextActions(parsed);

  // Track which keys the named extractions actually consumed (a key only
  // counts as consumed when it produced content — object-shaped `risks`
  // yield [] above and must still reach the generic pass below).
  const consumed = new Set<string>();
  if (summary) for (const k of ["summary", "conclusion"]) if (firstString(parsed, [k])) consumed.add(k);
  if (recommendation)
    for (const k of ["recommendation", "decision", "verdict"]) if (firstString(parsed, [k])) consumed.add(k);
  const arrayKeyGroups: Array<[string[], string[]]> = [
    [["strengths", "pros", "agreed"], strengths],
    [["weaknesses", "cons", "gaps"], weaknesses],
    [["risks", "concerns"], risks],
    [["tradeoffs", "trade_offs", "trade-offs"], tradeoffs],
  ];
  for (const [keys, extracted] of arrayKeyGroups) {
    if (extracted.length > 0) for (const k of keys) if (asStringArray(parsed[k]).length > 0) consumed.add(k);
  }
  if (coverage.length > 0)
    for (const k of ["coverage_matrix", "coverage", "criteria", "coverageMatrix"])
      if (Array.isArray(parsed[k])) consumed.add(k);
  if (dimensionScores.length > 0)
    for (const k of ["dimension_scores", "dimensionScores", "dimensions", "scores"])
      if (Array.isArray(parsed[k])) consumed.add(k);
  if (operationalRisks.length > 0)
    for (const k of ["operational_risks", "operationalRisks", "risk_matrix"])
      if (Array.isArray(parsed[k])) consumed.add(k);
  if (priorityFixes.length > 0)
    for (const k of ["priority_fixes", "priorityFixes", "fixes", "action_items"])
      if (Array.isArray(parsed[k])) consumed.add(k);
  if (nextActions.length > 0)
    for (const k of ["nextActions", "next_actions"]) if (Array.isArray(parsed[k])) consumed.add(k);

  const sections: Array<{ title: string; items: string[] }> = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (consumed.has(key) || NOISE_KEYS.has(key)) continue;
    const items = flattenValue(value);
    if (items.length > 0) sections.push({ title: titleCase(key), items });
  }

  const hasContent =
    !!summary ||
    !!recommendation ||
    strengths.length > 0 ||
    weaknesses.length > 0 ||
    risks.length > 0 ||
    tradeoffs.length > 0 ||
    coverage.length > 0 ||
    dimensionScores.length > 0 ||
    operationalRisks.length > 0 ||
    priorityFixes.length > 0 ||
    nextActions.length > 0 ||
    sections.length > 0;
  if (!hasContent) return null;

  return {
    summary,
    recommendation,
    strengths,
    weaknesses,
    risks,
    tradeoffs,
    coverage,
    dimensionScores,
    operationalRisks,
    priorityFixes,
    nextActions,
    sections,
  };
}

interface BulletSectionProps {
  title: string;
  items: string[];
  color: string;
  theme: Theme;
  marker?: string;
}

function BulletSection({ title, items, color, theme: t, marker = "•" }: BulletSectionProps) {
  if (items.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={color} attributes={1}>
        {title}
      </text>
      {items.map((it, i) => (
        <box key={`${title}-${i}`} flexDirection="row">
          <text fg={t.textMuted}>{`  ${marker} `}</text>
          <text fg={t.text}>{it}</text>
        </box>
      ))}
    </box>
  );
}

function DimensionScoreTable({ scores, theme: t }: { scores: DimensionScore[]; theme: Theme }) {
  if (scores.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={t.accent} attributes={1}>
        Dimension Scores
      </text>
      {scores.map((s, i) => (
        <box key={`dim-${i}`} flexDirection="column" marginTop={1}>
          <box flexDirection="row">
            <text fg={t.text}>{s.dimension}</text>
            <box flexGrow={1} />
            <text fg={scoreColor(s.score, t)} attributes={1}>
              {`${s.score}/5 ${scoreBar(s.score)}`}
            </text>
          </box>
          <text fg={t.textMuted}>{`    ${s.justification}`}</text>
        </box>
      ))}
    </box>
  );
}

function RiskTable({ risks, theme: t }: { risks: OperationalRisk[]; theme: Theme }) {
  if (risks.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={t.diffRemovedFg} attributes={1}>
        Operational Risks
      </text>
      {risks.map((r, i) => (
        <box key={`risk-${i}`} flexDirection="column" marginTop={1}>
          <box flexDirection="row">
            <text fg={t.text} attributes={1}>
              {r.risk}
            </text>
            <box flexGrow={1} />
            <text fg={severityColor(r.severity, t)}>{r.severity}</text>
          </box>
          <text fg={t.textMuted}>{`    Trigger: ${r.trigger}`}</text>
        </box>
      ))}
    </box>
  );
}

function PriorityFixList({ fixes, theme: t }: { fixes: string[]; theme: Theme }) {
  if (fixes.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={t.mdItalic} attributes={1}>
        Priority Fixes
      </text>
      {fixes.map((fix, i) => (
        <box key={`fix-${i}`} flexDirection="row">
          <text fg={t.textMuted}>{`  ${i + 1}. `}</text>
          <text fg={t.text}>{fix}</text>
        </box>
      ))}
    </box>
  );
}

function NextActionList({ actions, theme: t }: { actions: NextAction[]; theme: Theme }) {
  if (actions.length === 0) return null;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={t.planStepNum} attributes={1}>
        Next Actions
      </text>
      {actions.map((a, i) => (
        <box key={`act-${i}`} flexDirection="column" marginTop={1}>
          <box flexDirection="row">
            <text fg={t.textMuted}>{`  ${i + 1}. `}</text>
            <text fg={t.text} attributes={1}>
              {a.label}
            </text>
          </box>
          {a.reason && <text fg={t.textMuted}>{`     ${a.reason}`}</text>}
        </box>
      ))}
    </box>
  );
}

export interface CouncilConclusionCardProps {
  conclusion: ParsedConclusion;
  /** Round number for a per-round synthesis; undefined = final synthesis. */
  round?: number;
  theme: Theme;
}

export function CouncilConclusionCard({ conclusion, round, theme: t }: CouncilConclusionCardProps) {
  const title = round === undefined ? "Final Conclusion" : `Round ${round} Conclusion`;
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={t.councilSynthesisBorder}
      paddingLeft={2}
    >
      <text fg={t.councilSynthesisBorder} attributes={1}>
        {title}
      </text>
      {conclusion.summary && (
        <box marginTop={1}>
          <text fg={t.text}>{conclusion.summary}</text>
        </box>
      )}
      {conclusion.recommendation && (
        <box flexDirection="column" marginTop={1}>
          <text fg={t.accent} attributes={1}>
            Recommendation
          </text>
          <text fg={t.text}>{conclusion.recommendation}</text>
        </box>
      )}
      <DimensionScoreTable scores={conclusion.dimensionScores} theme={t} />
      <BulletSection title="Strengths" items={conclusion.strengths} color={t.diffAddedFg} theme={t} />
      <BulletSection title="Weaknesses" items={conclusion.weaknesses} color={t.diffRemovedFg} theme={t} />
      <RiskTable risks={conclusion.operationalRisks} theme={t} />
      <BulletSection title="Risks" items={conclusion.risks} color={t.diffRemovedFg} theme={t} />
      <BulletSection title="Trade-offs" items={conclusion.tradeoffs} color={t.mdItalic} theme={t} />
      <PriorityFixList fixes={conclusion.priorityFixes} theme={t} />
      <NextActionList actions={conclusion.nextActions} theme={t} />
      {conclusion.coverage.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={t.textMuted} attributes={1}>
            Coverage
          </text>
          {conclusion.coverage.map((row, i) => (
            <box key={`cov-${i}`} flexDirection="row">
              <text fg={t.textMuted}>{"  – "}</text>
              <text fg={t.text}>{row.join(" · ")}</text>
            </box>
          ))}
        </box>
      )}
      {conclusion.sections.map((sec) => (
        <BulletSection key={sec.title} title={sec.title} items={sec.items} color={t.accent} theme={t} />
      ))}
    </box>
  );
}
