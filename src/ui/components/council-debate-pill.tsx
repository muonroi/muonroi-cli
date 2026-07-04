import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Theme } from "../theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(id);
  }, []);
  return <>{SPINNER_FRAMES[frame]}</>;
}

export interface CouncilDebatePillProps {
  /** Number of debate turns folded into the pill (leader + debate + research). */
  count: number;
  /** Debate still running — show a spinner + live tail; false → done summary. */
  active: boolean;
  /** Expanded → render full transcript (children); collapsed → header + tail only. */
  expanded: boolean;
  /**
   * Last few non-empty lines of the most recent debate turn, joined with " · ".
   * Only shown while active + collapsed to mimic the "thinking" pill. Empty
   * string = nothing to show yet.
   */
  tailText: string;
  theme: Theme;
  /** Full debate bubbles, rendered only when `expanded` is true. */
  children?: ReactNode;
}

/**
 * Collapsible debate transcript, styled after the reasoning ("[Thought]") pill.
 *
 * The council debate can emit dozens of tall bubbles. Rendering them all inline
 * buries the synthesis/deliverable and floods the scrollback. This pill folds
 * the back-and-forth into a single line:
 *   - active + collapsed  → spinner + "Debating… (N turns)" + a live tail of the
 *     latest turn (like the reasoning pill's last-3-lines preview).
 *   - done   + collapsed  → "Debated N turns" summary; detail is hidden.
 *   - expanded            → full transcript in a left-bordered box.
 * Toggle via Ctrl+O (wired in use-app-logic handleKey). Synthesis is rendered
 * OUTSIDE this pill by the caller so the deliverable is always visible.
 *
 * ASCII-only strings on purpose: this file's siblings mangle non-ASCII glyphs
 * to mojibake under the repo's encoding, so we mirror the "[Thought]" pill idiom.
 */
export function CouncilDebatePill({ count, active, expanded, tailText, theme: t, children }: CouncilDebatePillProps) {
  const turnLabel = count === 1 ? "turn" : "turns";
  const header = active ? `[Council] Debating... (${count} ${turnLabel})` : `[Council] Debated ${count} ${turnLabel}`;
  const hint = expanded ? "Ctrl+O to collapse" : "Ctrl+O to expand";
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
      <box>
        {active ? (
          <text fg={t.accent}>
            <Spinner />
          </text>
        ) : null}
        <text fg={t.textMuted}>{`${active ? " " : ""}${header}  ·  ${hint}`}</text>
      </box>
      {expanded ? (
        <box border={["left"]} borderColor={t.textMuted} paddingLeft={2} marginTop={1} flexDirection="column">
          {children}
        </box>
      ) : active && tailText ? (
        <box border={["left"]} borderColor={t.textMuted} paddingLeft={2} marginTop={1}>
          <text fg={t.textMuted}>{tailText}</text>
        </box>
      ) : null}
    </box>
  );
}
