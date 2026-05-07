import { useEffect, useState } from "react";
import type { CouncilPhaseEvent } from "../../types/index.js";
import type { Theme } from "../theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface CouncilPhaseTimelineProps {
  phases: CouncilPhaseEvent[];
  theme: Theme;
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

export function CouncilPhaseTimeline({ phases, theme: t }: CouncilPhaseTimelineProps) {
  if (phases.length === 0) return null;
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={0} flexShrink={0}>
      {phases.map((p) => {
        const isError = p.state === "error";
        const isDone = p.state === "done";
        const marker = isError ? "✗" : isDone ? "✓" : <Spinner />;
        const markerColor = isError ? t.diffRemovedFg : isDone ? t.planOptionCheck : t.accent;
        const labelColor = isError ? t.diffRemovedFg : isDone ? t.textMuted : t.text;
        const elapsed = formatElapsed(p.elapsedMs);
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
            {p.errorMessage && (
              <box paddingLeft={2}>
                <text fg={t.diffRemovedFg}>{`└ ${truncate(p.errorMessage, 100)}`}</text>
              </box>
            )}
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
