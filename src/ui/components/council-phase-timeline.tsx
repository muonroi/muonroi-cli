import { useEffect, useState } from "react";
import type { CouncilPhaseEvent } from "../../types/index.js";
import type { Theme } from "../theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface CouncilPhaseTimelineProps {
  phases: CouncilPhaseEvent[];
  theme: Theme;
  /**
   * When false (default), completed phases fold into a single "N steps done"
   * summary line and only the live (active/error) phase is shown — the
   * aggressive-collapse UX. When true (Ctrl+O), the full done-trail is shown.
   * Shares the council transcript's expand state so one toggle controls all
   * council detail.
   */
  expanded?: boolean;
}

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(id);
  }, []);
  return <>{SPINNER_FRAMES[frame]}</>;
}

function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return "";
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/**
 * P4-D: heartbeat hook — re-renders consumers every `tickMs` so any phase whose
 * state is "active" and has a `startedAt` displays a live-ticking elapsed
 * counter. Without this, the timeline freezes at the last `elapsedMs` value
 * the emitter sent (only on state transitions) — which is exactly the "im lìm"
 * symptom the user reported.
 */
function useHeartbeat(tickMs = 1000): number {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return Date.now();
}

export function CouncilPhaseTimeline({ phases, theme: t, expanded = false }: CouncilPhaseTimelineProps) {
  const now = useHeartbeat(1000);
  // Collapse per-round brackets: the "Clarification round N" / "Round N" phases
  // duplicate the live status line ("Generating clarification questions (round
  // N)"), stacking 3-4 near-identical spinner rows at council start. Keep only
  // the coarse lifecycle phases here; round detail already rides on the status
  // line label. Errors are always shown so a failed round stays visible.
  const visible = phases.filter(
    (p) => !((p.kind === "clarification_round" || p.kind === "round") && p.state !== "error"),
  );
  if (visible.length === 0) return null;

  // Aggressive collapse (default): show only the live (active/error) phases as
  // full rows; fold every completed phase into one "N steps done" summary line.
  // Ctrl+O (expanded=true) restores the full done-trail. Errors are never
  // folded — a failed phase always stays visible.
  const live = visible.filter((p) => p.state === "active" || p.state === "error");
  const doneCount = visible.length - live.length;
  const rows = expanded ? visible : live;

  // Split off error phases so identical provider failures can be folded into one
  // row instead of N repeated blocks. A flaky proxy (Console Go glm/kimi) makes
  // clarify + spec-infer + eval all fail with the SAME message — rendered raw
  // that spammed the (narrow) context rail. Non-error rows keep their order.
  const nonErrorRows = rows.filter((p) => p.state !== "error");
  const errorRows = rows.filter((p) => p.state === "error");
  const errorGroups: Array<{ message: string; phases: CouncilPhaseEvent[] }> = [];
  for (const p of errorRows) {
    const message = p.errorMessage ?? "(failed)";
    const existing = errorGroups.find((g) => g.message === message);
    if (existing) existing.phases.push(p);
    else errorGroups.push({ message, phases: [p] });
  }

  const renderRow = (p: CouncilPhaseEvent) => {
    const isDone = p.state === "done";
    const marker = isDone ? "✓" : <Spinner />;
    const markerColor = isDone ? t.planOptionCheck : t.accent;
    const labelColor = isDone ? t.textMuted : t.text;
    const liveElapsedMs =
      p.state === "active" && typeof p.startedAt === "number" ? Math.max(0, now - p.startedAt) : p.elapsedMs;
    const elapsed = formatElapsed(liveElapsedMs);
    const meta = elapsed ? ` (${elapsed})` : isDone ? "" : " …";
    return (
      <box key={p.phaseId} flexDirection="column">
        <box>
          <text fg={markerColor}>{marker}</text>
          <text fg={labelColor}>{` ${p.label}`}</text>
          {meta && <text fg={t.textDim}>{meta}</text>}
        </box>
        {p.detail && (
          <box paddingLeft={2}>
            <text fg={t.textMuted}>{`└ ${truncate(p.detail, 100)}`}</text>
          </box>
        )}
      </box>
    );
  };

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={0} flexShrink={0}>
      {!expanded && doneCount > 0 && (
        <box>
          <text fg={t.planOptionCheck}>✓</text>
          <text fg={t.textDim}>{` ${doneCount} step${doneCount === 1 ? "" : "s"} done`}</text>
          <text fg={t.textMuted}>{"  ·  Ctrl+O to expand"}</text>
        </box>
      )}
      {nonErrorRows.map(renderRow)}
      {errorGroups.map((g) => {
        // One header per unique error; when >1 phase shares it, name the count
        // and list the affected steps compactly instead of repeating the message.
        const first = g.phases[0];
        const label =
          g.phases.length === 1
            ? first.label
            : `${g.phases.length} steps failed: ${g.phases.map((p) => p.label).join(", ")}`;
        return (
          <box key={`err-${first.phaseId}`} flexDirection="column">
            <box>
              <text fg={t.diffRemovedFg}>✗</text>
              <text fg={t.diffRemovedFg}>{` ${truncate(label, 100)}`}</text>
            </box>
            <box paddingLeft={2}>
              <text fg={t.diffRemovedFg}>{`└ ${truncate(g.message, 100)}`}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Reducer-friendly upsert: returns the next phase array given an incoming event.
 * Matches by phaseId; preserves insertion order for new phases. The first event
 * for a phaseId locks its position so later state transitions don't reshuffle
 * the timeline.
 */
export function upsertPhase(prev: CouncilPhaseEvent[], next: CouncilPhaseEvent): CouncilPhaseEvent[] {
  const idx = prev.findIndex((p) => p.phaseId === next.phaseId);
  if (idx === -1) return [...prev, next];
  const out = prev.slice();
  // Preserve elapsedMs/detail when transitioning from active → done if event omits them.
  out[idx] = {
    ...out[idx],
    ...next,
    detail: next.detail ?? out[idx].detail,
    elapsedMs: next.elapsedMs ?? out[idx].elapsedMs,
    errorMessage: next.errorMessage ?? out[idx].errorMessage,
  };
  return out;
}
