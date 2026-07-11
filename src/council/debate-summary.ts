/**
 * src/council/debate-summary.ts
 *
 * Fallback debate-summary synthesis.
 *
 * The /ideal research phase persists the debate into `research.md` +
 * `delegations.md` from `DebateState.runningSummary`. But a debate that returns
 * after opening statements (e.g. the leader routes straight to the preflight
 * gate without evaluation rounds) leaves `runningSummary` empty — and the whole
 * debate (opening positions, design/impl reasoning) was silently dropped from
 * the canonical artifacts, surviving only in TUI scrollback.
 *
 * This builds a faithful fallback from the participants' latest positions
 * (`active[]`), falling back to per-round archive excerpts, so the research
 * artifact ALWAYS captures the debate. Pure + synchronous → unit-testable.
 */

import type { DebateState } from "./types.js";

/** Cap so the fallback can't balloon the artifact; per-position + overall. */
const PER_POSITION_CHARS = 4000;
const TOTAL_CHARS = 16000;

/**
 * Return a markdown summary of the debate suitable for `research.md` /
 * `delegations.md`. Prefers `state.runningSummary` when present; otherwise
 * synthesizes one from `active[]` positions, then `archive[]` excerpts. Returns
 * "" only when there is genuinely nothing to show (no summary, no positions, no
 * archive) — callers keep their existing "(no summary produced)" placeholder.
 */
export function resolveDebateSummary(state: Pick<DebateState, "runningSummary" | "active" | "archive">): string {
  const running = state.runningSummary?.trim();
  if (running) return running;

  const fromPositions = summarizeFromActive(state.active);
  if (fromPositions) return fromPositions;

  return summarizeFromArchive(state.archive);
}

function speakerLabel(role: string, stanceName?: string): string {
  return stanceName?.trim() ? `${stanceName} (${role})` : role;
}

function summarizeFromActive(active: DebateState["active"] | undefined): string {
  if (!Array.isArray(active) || active.length === 0) return "";
  const parts: string[] = [
    "_(Synthesized from participants' final positions — the debate produced no running summary.)_",
    "",
  ];
  let total = 0;
  for (const p of active) {
    const position = (p.position ?? "").trim();
    if (!position) continue;
    const clipped = position.length > PER_POSITION_CHARS ? `${position.slice(0, PER_POSITION_CHARS)}…` : position;
    const block = `### ${speakerLabel(p.role, p.stance?.name)}\n\n${clipped}`;
    if (total + block.length > TOTAL_CHARS) {
      parts.push("_(remaining positions truncated)_");
      break;
    }
    parts.push(block, "");
    total += block.length;
  }
  // Only the header + no real positions → nothing worth persisting.
  return parts.length > 2 ? parts.join("\n").trimEnd() : "";
}

function summarizeFromArchive(archive: DebateState["archive"] | undefined): string {
  if (!Array.isArray(archive) || archive.length === 0) return "";
  const parts: string[] = [
    "_(Synthesized from per-round debate excerpts — the debate produced no running summary.)_",
    "",
  ];
  let total = 0;
  for (const e of archive) {
    const excerpt = (e.excerpt ?? "").trim();
    if (!excerpt) continue;
    const block = `### Round ${e.round} — ${speakerLabel(e.role, e.stanceName)}\n\n${excerpt}`;
    if (total + block.length > TOTAL_CHARS) {
      parts.push("_(remaining excerpts truncated)_");
      break;
    }
    parts.push(block, "");
    total += block.length;
  }
  return parts.length > 2 ? parts.join("\n").trimEnd() : "";
}
