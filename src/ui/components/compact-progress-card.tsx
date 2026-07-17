/**
 * src/ui/components/compact-progress-card.tsx
 *
 * Live progress for a /compact run. Before this, `/compact` awaited two LLM
 * passes with zero UI — a minute of a frozen screen that reads as a hang.
 *
 * The percentage comes from the compaction pipeline itself
 * (flow/compaction/progress.ts), not from a timer: it advances on real stage
 * boundaries, and the dominant compress pass streams so it moves continuously.
 * The elapsed clock is what proves liveness while a stage is mid-flight.
 */

import { useEffect, useState } from "react";
import type { CompactProgress } from "../../flow/compaction/progress.js";
import { Region } from "../primitives/semantic-primitives.js";
import type { Theme } from "../theme.js";

const BAR_WIDTH = 34;

/** Elapsed as the status line shows it: "42s", "1m 19s". */
export function fmtCompactElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/** Filled/unfilled bar of exactly `width` cells for a 0..100 percent. */
export function compactBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export interface CompactProgressCardProps {
  progress: CompactProgress;
  /** Epoch ms the run started. */
  startedAt: number;
  t: Theme;
}

export function CompactProgressCard({ progress, startedAt, t }: CompactProgressCardProps) {
  // The card owns its clock: a compaction can sit inside one LLM pass for a
  // minute, and re-rendering the whole transcript once a second just to advance
  // a timer is a cost the rest of the app should not pay.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = fmtCompactElapsed(now - startedAt);
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));

  return (
    <Region
      id="compact-progress"
      name={progress.label}
      value={`${pct}%`}
      state={progress.stage}
      props={{ percent: pct, elapsedMs: now - startedAt }}
    >
      <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
        <text>
          <span style={{ fg: t.accent }}>{"✦ "}</span>
          <span style={{ fg: t.text }}>{progress.label}</span>
          <span style={{ fg: t.textMuted }}>{`  (${elapsed})`}</span>
        </text>
        <box paddingLeft={2}>
          <text>
            <span style={{ fg: t.accent }}>{compactBar(pct)}</span>
            <span style={{ fg: t.textMuted }}>{`  ${pct}%`}</span>
          </text>
        </box>
      </box>
    </Region>
  );
}
