import { useEffect, useState } from "react";
import type { CouncilStatusData } from "../../types/index.js";
import type { Theme } from "../theme.js";

const SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"];
const DONE_HOLD_MS = 1500;

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return <>{SPINNER_FRAMES[frame]}</>;
}

/**
 * Re-render every `tickMs` so active rows show a live-ticking elapsed counter.
 * Without this the row freezes at the last emitter-sent elapsedMs (emitters
 * only send on state transitions) — the same "im lìm" symptom the phase
 * timeline fixed with its own heartbeat (council-phase-timeline.tsx).
 */
function useHeartbeat(tickMs = 1000): number {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return Date.now();
}

function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function formatTokens(s: CouncilStatusData): string {
  const parts: string[] = [];
  if (typeof s.tokensIn === "number") parts.push(`↑ ${s.tokensIn}`);
  if (typeof s.tokensOut === "number") parts.push(`↓ ${s.tokensOut}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")} tokens` : "";
}

export interface CouncilStatusListProps {
  statuses: CouncilStatusData[];
  theme: Theme;
}

export function CouncilStatusList({ statuses, theme: t }: CouncilStatusListProps) {
  // Hook must run unconditionally — before the empty-list early return.
  const now = useHeartbeat(1000);
  if (statuses.length === 0) return null;
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={0} flexShrink={0}>
      {statuses.map((s) => {
        const isError = s.state === "error";
        const isDone = s.state === "done";
        const marker = isError ? "✗" : isDone ? "✓" : <Spinner />;
        const markerColor = isError ? t.diffRemovedFg : isDone ? t.planOptionCheck : t.accent;
        const labelColor = isError ? t.diffRemovedFg : t.text;
        const isLive = s.state === "start" || s.state === "tick";
        const liveElapsedMs = isLive && typeof s.startedAt === "number" ? Math.max(0, now - s.startedAt) : s.elapsedMs;
        const meta = `(${formatElapsed(liveElapsedMs)}${formatTokens(s)})`;
        return (
          <box key={s.statusId} flexDirection="column">
            <box>
              <text fg={markerColor}>{marker}</text>
              <text fg={labelColor}>{` ${s.label}`}</text>
              <text fg={t.textMuted}>{` ${meta}`}</text>
            </box>
            {s.detail && (
              <box paddingLeft={2}>
                <text fg={t.textMuted}>{`└ ${truncate(s.detail, 90)}`}</text>
              </box>
            )}
            {s.errorMessage && (
              <box paddingLeft={2}>
                <text fg={t.diffRemovedFg}>{`└ ${truncate(s.errorMessage, 90)}`}</text>
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
 * Reducer-friendly upsert: returns the next status array given an incoming
 * status chunk. Done statuses are kept until DONE_HOLD_MS expires (caller
 * should call {@link reapStatuses} on a timer or via React state effects).
 */
export function upsertStatus(prev: CouncilStatusData[], next: CouncilStatusData): CouncilStatusData[] {
  const idx = prev.findIndex((s) => s.statusId === next.statusId);
  if (idx === -1) {
    // Stamp a client-side start anchor so the row can live-tick between emitter
    // updates (emitters only send elapsedMs on state transitions).
    const startedAt = next.startedAt ?? Date.now() - (next.elapsedMs ?? 0);
    return [...prev, { ...next, startedAt }];
  }
  const out = prev.slice();
  out[idx] = { ...next, startedAt: next.startedAt ?? out[idx].startedAt };
  return out;
}

/** Remove `done` rows that finished more than DONE_HOLD_MS ago. */
export function reapStatuses(prev: CouncilStatusData[], doneAt: Map<string, number>, now: number): CouncilStatusData[] {
  return prev.filter((s) => {
    if (s.state !== "done") return true;
    const t = doneAt.get(s.statusId);
    if (t === undefined) return true;
    return now - t < DONE_HOLD_MS;
  });
}
