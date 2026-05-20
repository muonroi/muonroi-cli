import { useCallback } from "react";
import type { MODES } from "../../types/index.js";
import { copyTextToHostClipboard } from "../../utils/host-clipboard.js";
import type { Theme } from "../theme.js";
import type { ContextStats } from "../types.js";
import { formatTokenCount } from "../utils/text.js";

export function SessionHeader({
  t,
  modeInfo,
  sessionTitle,
  sessionId,
  onCopySessionId,
}: {
  t: Theme;
  modeInfo: (typeof MODES)[number];
  sessionTitle: string | null;
  sessionId: string | null;
  onCopySessionId?: () => void;
}) {
  const handleSessionIdClick = useCallback(() => {
    if (sessionId) {
      copyTextToHostClipboard(sessionId);
      onCopySessionId?.();
    }
  }, [sessionId, onCopySessionId]);

  return (
    <box flexShrink={0} width="100%">
      <box flexDirection="row" width="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <text>
          <span style={{ fg: modeInfo.color }}>
            <b>{modeInfo.label}</b>
          </span>
          {sessionTitle ? (
            <span style={{ fg: t.text }}>
              <b>
                {": "}
                {sessionTitle}
              </b>
            </span>
          ) : null}
        </text>
        <box flexGrow={1} />
        {sessionId ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI <text> is a custom terminal renderer element, not an HTML span
          <text fg={t.textDim} onMouseUp={handleSessionIdClick}>
            {sessionId}
          </text>
        ) : null}
      </box>
    </box>
  );
}

export function ContextMeter({ t, stats }: { t: Theme; stats: ContextStats }) {
  // Show USED, not remaining — "93% 119K" is universally read as "used", and
  // showing remaining caused users to mistake low usage for impending overflow.
  // Color thresholds match common context-window UX (yellow ≥70%, red ≥90%).
  const pct = Math.round(stats.ratioUsed * 100);
  const color = stats.ratioUsed >= 0.9 ? "red" : stats.ratioUsed >= 0.7 ? "yellow" : t.textMuted;
  return (
    <text>
      <span style={{ fg: color }}>{`${pct}%`}</span>
      <span style={{ fg: t.textDim }}>{` ${formatTokenCount(stats.usedTokens)}`}</span>
    </text>
  );
}
