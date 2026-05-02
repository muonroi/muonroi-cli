/**
 * src/ui/status-bar/index.tsx
 *
 * OpenTUI status bar React component composing the 6 slots:
 * [provider/model] | [tier badge] | [in/out tokens session] | [USD session | month] | [degraded marker]
 *
 * Subscribes to statusBarStore for live updates (no polling).
 */

import * as React from "react";
import { type StatusBarState, statusBarStore } from "./store.js";
import { TierBadge } from "./tier-badge.js";
import { UsdMeter } from "./usd-meter.js";

function useStatusBarState(): StatusBarState {
  const [s, set] = React.useState(statusBarStore.getState());
  React.useEffect(() => statusBarStore.subscribe(set), []);
  return s;
}

/** Pure render function -- testable without React hooks context. */
export function renderStatusBar(s: StatusBarState): React.ReactElement {
  const slots: React.ReactNode[] = [
    React.createElement(
      "text",
      { key: "pm", "data-testid": "slot-provider-model" },
      `${s.provider || "-"}/${s.model || "-"}`,
    ),
    React.createElement(TierBadge, { key: "tier", tier: s.tier }),
    React.createElement("text", { key: "tok", "data-testid": "slot-tokens" }, `in:${s.in_tokens} out:${s.out_tokens}`),
    React.createElement(UsdMeter, {
      key: "usd",
      session_usd: s.session_usd,
      month_usd: s.month_usd,
      current_pct: s.current_pct,
    }),
  ];

  if (s.degraded) {
    slots.push(
      React.createElement(
        "text",
        { key: "deg", color: "yellow", blink: true, "data-testid": "slot-degraded" },
        "DEGRADED",
      ),
    );
  }

  // Join slots with ' | ' separators
  const joined: React.ReactNode[] = [];
  slots.forEach((el, i) => {
    if (i > 0) joined.push(React.createElement("text", { key: `sep-${i}` }, " | "));
    joined.push(el);
  });

  return React.createElement("box", { "data-testid": "status-bar", flexDirection: "row" }, ...joined);
}

/** React component with hook-based subscription -- used in app.tsx layout. */
export function StatusBar(): React.ReactElement {
  const s = useStatusBarState();
  return renderStatusBar(s);
}
