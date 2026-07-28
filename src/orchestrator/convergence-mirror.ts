/**
 * src/orchestrator/convergence-mirror.ts
 *
 * A per-step "you are here" note injected via `attachReminderToMessages` inside
 * `prepareStep`. Born out of the d0fbdd730b08 cost-leak post-mortem: a user
 * typed "k" and the agent ran 42 tool calls (24 distinct greps + 13 reads, all
 * circling the same resume/todo-pin concept) without converging, because each
 * individual step looked like progress. The agent had no view of its OWN
 * tool-call history as a whole.
 *
 * This module computes that view from the SDK's `stepMessages` (the prior
 * assistant+tool messages AI SDK hands to `prepareStep`) and emits a compact
 * reflection. When the signal is strong (many exploratory tools, declining
 * output, high concept overlap), the note also surfaces two hints — `ask_user`
 * and `ee_query` — so the model has the tools to break out of a fumble. It
 * never blocks the turn; the model decides whether to act on the hints.
 *
 * Agent-first by design (per the project's directive and the removed regex
 * clarity gate in `clarity-gate.ts`):
 *   - Pure function. No side effects, no state.
 *   - Only READS `stepMessages`. No mutation, no history persistence.
 *   - Output is a string (or "" when there's nothing worth mirroring).
 *   - No hardcoded "stop after N" — verdicts are computed signals, not caps.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The minimal slice of a ModelMessage this module needs. We accept the SDK's
 * full type at the call site and narrow here so the module is testable without
 * importing the AI SDK types into tests.
 */
export interface MirrorMessage {
  role: "assistant" | "tool" | "user" | "system" | string;
  content: unknown;
}

interface ToolCallPart {
  type: "tool-call";
  toolName: string;
  // AI SDK v6 uses `input`; older snapshots used `args`. Accept both.
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ToolResultPart {
  type: "tool-result";
  toolName: string;
  output?: string | { type: "text"; value?: string } | { type: "json"; value?: unknown } | Record<string, unknown>;
}

export interface ConvergenceMirrorOpts {
  /** Step number this note will be attached to (1-based; matches SDK stepNumber). */
  stepNumber: number;
  /**
   * Minimum distinct exploratory queries (grep/read) before the convergence
   * verdict engages. Default 3 — below that the agent is still legitimately
   * gathering context, not fumbling. NOT a hard cap; just where the signal
   * becomes meaningful enough to mirror.
   */
  minExploreForVerdict?: number;
  /** Hard cap on note length (chars) so it never blows context. Default 600. */
  maxNoteChars?: number;
}

export type ConvergenceVerdict = "HIGH" | "MEDIUM" | "LOW";

// ── Tool-call extraction ────────────────────────────────────────────────────

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

function isToolCall(p: unknown): p is ToolCallPart {
  return !!p && typeof p === "object" && (p as { type?: string }).type === "tool-call";
}
function isToolResult(p: unknown): p is ToolResultPart {
  return !!p && typeof p === "object" && (p as { type?: string }).type === "tool-result";
}

interface ToolCallDigest {
  tool: string;
  /** Short human label for the most relevant arg (pattern/path/command/file_path). */
  label: string;
}

const EXPLORATORY_TOOLS = new Set(["grep", "rg", "read_file", "read", "glob", "list_directory"]);

/** Pull a stable, short label from the most relevant arg of a tool call. */
function labelForToolCall(tc: ToolCallPart): string {
  const args = (tc.input ?? tc.args ?? {}) as Record<string, unknown>;
  // Order matters: pattern is the most diagnostic for grep; file_path for read.
  const raw =
    (typeof args.pattern === "string" && args.pattern) ||
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.command === "string" && args.command) ||
    (typeof args.query === "string" && args.query) ||
    "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

function collectToolCalls(messages: MirrorMessage[]): ToolCallDigest[] {
  const out: ToolCallDigest[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of asArray(m.content)) {
      if (isToolCall(p)) out.push({ tool: p.toolName, label: labelForToolCall(p) });
    }
  }
  return out;
}

// ── Concept-overlap signal ──────────────────────────────────────────────────

/**
 * Normalize a grep pattern / label into a lowercase alpha-numeric haystack:
 * regex metachars stripped, separators collapsed. We then probe overlap with
 * SUBSTRINGS, not just whole-word tokens — `clipboard` and `pinboard` share
 * `board` (a 5-char fragment) even though they're distinct words. This is the
 * signal the d0fbdd730b08 post-mortem needed: 5 distinct greps circling one
 * concept but with no single shared keyword.
 *
 * NOT keyword matching — a structural overlap probe. Two queries share a
 * concept iff they share at least one FRAGMENT of `MIN_FRAGMENT` chars.
 */
const MIN_FRAGMENT = 4;
const STOPWORDS = new Set([
  // Common substrings that don't indicate concept overlap.
  "true",
  "false",
  "null",
  "undefined",
  "from",
  "with",
  "this",
  "that",
  // Common English suffixes — `tion`, `ation`, `ement` etc. match across
  // unrelated words (e.g. `authentication` vs `connection` share `tion`).
  // Excluding them stops false-positive overlap on distinct searches.
  "tion",
  "ation",
  "ation",
  "ssion",
  "ement",
  "iness",
  "tions",
  "ables",
  "ables",
  "ingly",
  "ously",
  "where",
  "these",
  "those",
  "their",
]);

/** Extract all alpha-numeric fragments ≥ MIN_FRAGMENT from a label. */
function fragmentsFromLabel(label: string): string[] {
  const cleaned = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, " ");
  const out = new Set<string>();
  for (const word of cleaned.split(/[^a-z0-9]+/)) {
    if (word.length < MIN_FRAGMENT) continue;
    // Sliding window so `clipboard` exposes `clip`, `lipb`, `ipbo`, `boar`, `oard`,
    // `board`, etc. — lets it match `pinboard` via `board`.
    for (let i = 0; i <= word.length - MIN_FRAGMENT; i++) {
      const frag = word.slice(i, i + MIN_FRAGMENT);
      if (!STOPWORDS.has(frag)) out.add(frag);
    }
  }
  return Array.from(out);
}

interface OverlapResult {
  /** How many of the distinct exploratory queries share ≥1 fragment with another. */
  overlapping: number;
  total: number;
  /** A representative shared fragment, for the human label (longest one). */
  sharedTopic: string | null;
}

function conceptOverlap(digests: ToolCallDigest[]): OverlapResult {
  const explore = digests.filter((d) => EXPLORATORY_TOOLS.has(d.tool) && d.label.length > 0);
  if (explore.length < 2) return { overlapping: 0, total: explore.length, sharedTopic: null };

  const fragSets = explore.map((d) => new Set(fragmentsFromLabel(d.label)));
  // Count queries that share at least one fragment with any OTHER query.
  let overlapping = 0;
  const sharedFragCounts = new Map<string, number>();
  for (let i = 0; i < fragSets.length; i++) {
    let iOverlaps = false;
    for (let j = 0; j < fragSets.length; j++) {
      if (i === j) continue;
      for (const frag of fragSets[i]) {
        if (fragSets[j].has(frag)) {
          iOverlaps = true;
          sharedFragCounts.set(frag, (sharedFragCounts.get(frag) ?? 0) + 1);
        }
      }
    }
    if (iOverlaps) overlapping++;
  }
  // For the human-readable topic label, pick the LONGEST contiguous substring
  // (≥ MIN_FRAGMENT) that appears in the most queries — `migration` over `migr`.
  // We rescan the labels for the longest shared run rather than using the
  // sliding fragments directly (they're 4 chars by construction).
  const sharedTopic = pickLongestSharedTopic(
    explore.map((d) => d.label),
    sharedFragCounts,
  );
  return { overlapping, total: explore.length, sharedTopic };
}

/** Find the longest contiguous substring (≥ MIN_FRAGMENT) appearing in ≥2 labels. */
function pickLongestSharedTopic(labels: string[], fragCounts: Map<string, number>): string | null {
  if (fragCounts.size === 0) return null;
  // Seed candidates from the sliding fragments (guaranteed ≥ MIN_FRAGMENT).
  // For each candidate, extend it left/right within each label that contains it
  // to recover the longest contiguous run. Cheap: at most a few labels × short strings.
  let best: string | null = null;
  for (const frag of fragCounts.keys()) {
    let bestRun = frag;
    for (const label of labels) {
      const lc = label.toLowerCase();
      const idx = lc.indexOf(frag);
      if (idx < 0) continue;
      // Extend left while the preceding char is alnum and present in another label.
      let lo = idx;
      while (lo > 0 && /[a-z0-9]/.test(lc[lo - 1] ?? "")) {
        const extended = lc.slice(lo - 1, idx + frag.length);
        // Count how many labels contain this extended run.
        const hits = labels.filter((l) => l.toLowerCase().includes(extended)).length;
        if (hits >= 2) {
          bestRun = extended;
          lo--;
        } else break;
      }
      // Extend right.
      let hi = idx + frag.length;
      while (hi < lc.length && /[a-z0-9]/.test(lc[hi] ?? "")) {
        const extended = lc.slice(lo, hi + 1);
        const hits = labels.filter((l) => l.toLowerCase().includes(extended)).length;
        if (hits >= 2) {
          bestRun = extended;
          hi++;
        } else break;
      }
    }
    if (!best || bestRun.length > best.length) best = bestRun;
  }
  return best;
}

// ── Output-size signal ──────────────────────────────────────────────────────

function outputSizeOf(part: ToolResultPart): number {
  const o = part.output;
  if (typeof o === "string") return o.length;
  if (o && typeof o === "object") {
    const t = (o as { type?: string }).type;
    if (t === "text") {
      const v = (o as { value?: string }).value;
      return typeof v === "string" ? v.length : 0;
    }
    if (t === "json") {
      const v = (o as { value?: unknown }).value;
      try {
        return v === undefined ? 0 : JSON.stringify(v).length;
      } catch {
        return 0;
      }
    }
    try {
      return JSON.stringify(o).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Sum tool-result sizes per assistant step (each assistant step's tool results
 * follow it). Returns an array of per-step total sizes, oldest first.
 */
function perStepOutputSizes(messages: MirrorMessage[]): number[] {
  const sizes: number[] = [];
  let current = 0;
  let sawAny = false;
  for (const m of messages) {
    if (m.role === "assistant") {
      if (sawAny) sizes.push(current);
      current = 0;
      sawAny = true;
    } else if (m.role === "tool") {
      for (const p of asArray(m.content)) {
        if (isToolResult(p)) current += outputSizeOf(p);
      }
    }
  }
  if (sawAny) sizes.push(current);
  return sizes;
}

/** True iff the last 3 sizes are strictly decreasing (each < previous). */
function isDeclining(sizes: number[]): boolean {
  if (sizes.length < 3) return false;
  const last3 = sizes.slice(-3);
  return last3[0] > last3[1] && last3[1] > last3[2] && last3[2] < last3[0] * 0.5;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Build a compact "you are here" reflection of the turn's tool history. Returns
 * "" when there is nothing worth mirroring (first step, or too few calls).
 */
export function buildConvergenceMirror(messages: MirrorMessage[], opts: ConvergenceMirrorOpts): string {
  const stepNumber = opts.stepNumber;
  const minExplore = opts.minExploreForVerdict ?? 3;
  const maxChars = opts.maxNoteChars ?? 600;

  const digests = collectToolCalls(messages);
  if (digests.length === 0) return ""; // nothing to mirror yet

  // Tally by tool name.
  const byTool = new Map<string, ToolCallDigest[]>();
  for (const d of digests) {
    if (!byTool.has(d.tool)) byTool.set(d.tool, []);
    byTool.get(d.tool)!.push(d);
  }

  const overlap = conceptOverlap(digests);
  const sizes = perStepOutputSizes(messages);
  const declining = isDeclining(sizes);

  // Verdict — computed, not capped. Engages only past minExplore queries so a
  // healthy 2-search start doesn't get a LOW verdict.
  let verdict: ConvergenceVerdict | null = null;
  if (overlap.total >= minExplore) {
    const overlapRatio = overlap.overlapping / overlap.total;
    if (overlapRatio >= 0.6 || (overlap.total >= 5 && overlapRatio >= 0.4)) verdict = "LOW";
    else if (overlapRatio >= 0.3) verdict = "MEDIUM";
    else verdict = "HIGH";
  }

  // Assemble the note.
  const lines: string[] = [
    `[step ${stepNumber} mirror] This turn: ${digests.length} tool call(s) across ${Math.max(0, sizes.length)} step(s).`,
  ];

  // Per-tool tally with up to 4 sample labels.
  const tallyLines: string[] = [];
  for (const [tool, calls] of byTool) {
    const sample = Array.from(new Set(calls.map((c) => c.label)))
      .filter(Boolean)
      .slice(0, 4)
      .map((l) => `'${l}'`)
      .join(", ");
    tallyLines.push(sample ? `  ${tool}×${calls.length} (${sample})` : `  ${tool}×${calls.length}`);
  }
  lines.push(...tallyLines);

  if (overlap.total >= 2 && overlap.overlapping > 0) {
    const topic = overlap.sharedTopic ? ` (shared concept: "${overlap.sharedTopic}")` : "";
    lines.push(`  Exploratory overlap: ${overlap.overlapping}/${overlap.total} queries target the same area${topic}.`);
  }
  if (declining && sizes.length >= 3) {
    lines.push(
      `  Output gained is declining (${Math.round(sizes[sizes.length - 3] / 1000)}KB → ${Math.round(
        sizes[sizes.length - 1] / 1000,
      )}KB across last 3 steps).`,
    );
  }

  // Hints engage only when convergence is genuinely low. NOT a hard rule.
  if (verdict === "LOW") {
    lines.push(
      `  → Convergence: LOW — you've explored ${overlap.total} angles on the same target without a clear next read.`,
    );
    const topic = overlap.sharedTopic ?? "this issue";
    lines.push(
      `    Consider: (a) ask_user "what specific symptom / before-after steps?" when you can't decide the next read;`,
    );
    lines.push(
      `              (b) ee_query "exploring without converging on ${topic}" to recall whether a similar past exploration was a dead-end.`,
    );
  } else if (verdict === "MEDIUM") {
    lines.push(
      `  → Convergence: MEDIUM — some overlap in your recent searches. Aim for a decision before adding more.`,
    );
  }

  let note = lines.join("\n");
  if (note.length > maxChars) note = `${note.slice(0, maxChars - 3)}...`;
  return note;
}
