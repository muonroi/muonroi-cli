import { Semantic } from "@muonroi/agent-harness-opentui";
import { dark } from "../theme.js";

export interface JumpToLatestPillProps {
  /** Number of new appends suppressed since the user scrolled up. Always ≥ 1:
   *  app.tsx renders the pill only when there is new content to announce. */
  newSinceLock: number;
}

/**
 * Scroll-lock affordance (MUONROI_SCROLL_LOCK): shown pinned to the bottom of
 * the transcript when the user has scrolled up while new content is arriving.
 * Pressing End re-pins to the live tail. Glyph-free (ASCII only) so it renders
 * on every terminal — the debate pill work proved non-`● ✓` glyphs are unsafe.
 */
export function JumpToLatestPill({ newSinceLock }: JumpToLatestPillProps) {
  const label = `${newSinceLock} new below - press End to jump`;
  return (
    <Semantic id="jump-to-latest" role="region" props={{ newSinceLock }}>
      <box flexDirection="row" alignSelf="center" paddingLeft={1} paddingRight={1} backgroundColor={dark.accent}>
        <text fg="#ffffff" attributes={1}>
          {label}
        </text>
      </box>
    </Semantic>
  );
}
