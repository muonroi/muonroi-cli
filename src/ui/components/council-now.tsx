import { Semantic } from "@muonroi/agent-harness-opentui";
import { useRef } from "react";
import type { CouncilStatusData } from "../../types/index.js";
import type { Theme } from "../theme.js";

/**
 * `council-rail-now` — the liveness block, Concept 4's single most-protected
 * element (pain point #3: "alive vs hung ambiguity"). It answers, at a glance
 * and without interpretation, whether the debate is streaming, stalled, or
 * waiting on a human.
 *
 * HONEST DATA ONLY. Every field comes from an already-tracked source; nothing
 * is invented:
 *   - `streamedChars` / `lastDeltaAgeMs` are push-based stream counters carried
 *     on the live `council_status` chunk (see CouncilStatusData) — growing chars
 *     + small age = slow-but-alive; static chars + growing age = genuinely
 *     stuck. Available at PHASE granularity (research / opening / exchange-round).
 *   - `waiting` is derived from an open clarification askcard, a state distinct
 *     from a stall — a human-wait must never read as a hang.
 * When no live status and not waiting, the block renders `idle` rather than a
 * fake meter.
 */

/** Delta age past which a phase with static chars is treated as stalled. */
const STALL_MS = 8000;

/** How many streamedChars samples the heartbeat retains (one bar each). */
const HEARTBEAT_SAMPLES = 12;
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * htop-style heartbeat: a chars-per-tick sparkline built from the DELTAS between
 * consecutive streamedChars samples. Honest — every bar is real observed stream
 * growth sampled across renders, no synthetic motion. `<2` samples → "" (nothing
 * to diff yet). Deltas are normalised to the window max so the newest burst is
 * always full-height and a slowing stream visibly shrinks.
 */
export function heartbeatBars(samples: number[]): string {
  if (samples.length < 2) return "";
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i++) deltas.push(Math.max(0, (samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  const max = Math.max(...deltas, 1);
  return deltas
    .map((d) => SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, Math.floor((d / max) * SPARK_BLOCKS.length))])
    .join("");
}

function formatChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatAge(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export type CouncilLiveness = "alive" | "stalled" | "waiting" | "idle";

export function resolveCouncilLiveness(status: CouncilStatusData | null, waiting: boolean): CouncilLiveness {
  if (waiting) return "waiting";
  if (!status || (status.state !== "start" && status.state !== "tick")) return "idle";
  const age = status.lastDeltaAgeMs;
  if (age !== undefined && age >= STALL_MS) return "stalled";
  return "alive";
}

export interface CouncilNowProps {
  /** The current live status (state start|tick) driving the debate, or null. */
  status: CouncilStatusData | null;
  /** Round label like "r2" appended to the speaker line, or null. */
  roundLabel?: string | null;
  /** True when a clarification askcard is blocking on the user. */
  waiting?: boolean;
  width: number;
  theme: Theme;
}

export function CouncilNowBlock({ status, roundLabel, waiting = false, width, theme }: CouncilNowProps) {
  const liveness = resolveCouncilLiveness(status, waiting);
  const streamedChars = status?.streamedChars ?? 0;
  const ageMs = status?.lastDeltaAgeMs;
  const inner = Math.max(8, width - 3);
  const role = status?.role || status?.label || "council";

  // Sample streamedChars across renders into a per-speaker ring so the heartbeat
  // reflects THIS speaker's live stream. Reset when the stream idles/waits or the
  // speaker changes, so an old heartbeat never bleeds into a new turn. Sampling in
  // render is safe here: it is a viz ref (not state) and the changed-value guard
  // makes a repeated render idempotent.
  const histRef = useRef<{ role: string; samples: number[] }>({ role: "", samples: [] });
  const streaming = liveness === "alive" || liveness === "stalled";
  if (streaming) {
    const h = histRef.current;
    if (h.role !== role) {
      h.role = role;
      h.samples = [];
    }
    if (h.samples.length === 0 || h.samples[h.samples.length - 1] !== streamedChars) {
      h.samples = [...h.samples, streamedChars].slice(-HEARTBEAT_SAMPLES);
    }
  } else {
    histRef.current = { role: "", samples: [] };
  }
  const heartbeat = heartbeatBars(histRef.current.samples);

  const stateColor =
    liveness === "alive"
      ? theme.diffAddedFg
      : liveness === "stalled"
        ? theme.initFormError
        : liveness === "waiting"
          ? theme.planOptionSelected // amber — a human-wait, NOT a fault
          : theme.textMuted;

  // htop-style single-line meter: fill drains as the last-delta age climbs
  // toward the stall threshold, so a slowing stream visibly empties before it
  // ever flips to the red "stalled" label.
  const barW = Math.max(6, Math.min(12, inner - 10));
  const fillRatio =
    liveness === "alive"
      ? ageMs === undefined
        ? 1
        : Math.max(0, 1 - Math.min(ageMs, STALL_MS) / STALL_MS)
      : liveness === "waiting"
        ? 1
        : 0;
  const filled = Math.round(fillRatio * barW);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barW - filled));

  const speakerLine =
    liveness === "waiting"
      ? "⏸ waiting for input"
      : liveness === "idle"
        ? "idle"
        : `● ${role}${roundLabel ? `  ${roundLabel}` : ""}`;

  const meterLabel =
    liveness === "alive"
      ? "alive"
      : liveness === "stalled"
        ? `stalled${ageMs !== undefined ? ` ${formatAge(ageMs)}` : ""}`
        : liveness === "waiting"
          ? "waiting"
          : "—";

  return (
    <Semantic
      id="council-rail-now"
      role="status"
      name="VITALS"
      props={{
        liveness,
        streamedChars,
        lastDeltaAgeMs: ageMs ?? -1,
        alive: liveness === "alive",
        waiting: liveness === "waiting",
      }}
    >
      <box flexShrink={0} flexDirection="column">
        <text fg={stateColor}>{speakerLine}</text>
        {liveness !== "waiting" && liveness !== "idle" && (
          <text fg={theme.textMuted}>
            {`${formatChars(streamedChars)} ch ↑`}
            {ageMs !== undefined ? `  Δ ${formatAge(ageMs)}` : ""}
          </text>
        )}
        {/* htop heartbeat (chars-per-tick) + the drain meter on one line. The
            heartbeat proves motion; the meter encodes the alive→stalled state. */}
        <text>
          {heartbeat ? <span style={{ fg: stateColor }}>{`${heartbeat} `}</span> : null}
          <span style={{ fg: stateColor }}>{bar}</span>
          <span style={{ fg: theme.textMuted }}>{` ${meterLabel}`}</span>
        </text>
      </box>
    </Semantic>
  );
}
