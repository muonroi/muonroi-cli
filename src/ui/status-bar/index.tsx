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

const EE_DOT: Record<string, { color: string; symbol: string }> = {
  ok: { color: "green", symbol: "●" },      // ●
  warn: { color: "yellow", symbol: "●" },    // ●
  down: { color: "red", symbol: "●" },        // ●
  unknown: { color: "gray", symbol: "○" },    // ○
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/** Pure render function -- testable without React hooks context. */
export function renderStatusBar(s: StatusBarState): React.ReactElement {
  const modelLabel = s.routed_from && s.routed_from !== s.model
    ? `${s.provider || "-"}/${s.routed_from}→${s.model}`
    : `${s.provider || "-"}/${s.model || "-"}`;

  const tokenStr = `↑${fmtTokens(s.in_tokens)} ↓${fmtTokens(s.out_tokens)}${s.cache_read_tokens ? ` ⊚${fmtTokens(s.cache_read_tokens)}` : ""}`;
  const ee = EE_DOT[s.ee_status] ?? EE_DOT.unknown;

  const slots: React.ReactNode[] = [
    React.createElement(
      "text",
      { key: "pm", fg: "#5c9cf5", "data-testid": "slot-provider-model" },
      modelLabel,
    ),
    React.createElement(TierBadge, { key: "tier", tier: s.tier }),
    React.createElement("text", { key: "tok", fg: "cyan", "data-testid": "slot-tokens" }, `${tokenStr} ${fmtCost(s.session_usd)}`),
    React.createElement(UsdMeter, {
      key: "usd",
      session_usd: s.session_usd,
      month_usd: s.month_usd,
      current_pct: s.current_pct,
    }),
    React.createElement(
      "text",
      { key: "ee", fg: ee.color, "data-testid": "slot-ee" },
      ee.symbol,
    ),
  ];

  if (s.degraded) {
    slots.push(
      React.createElement(
        "text",
        { key: "deg", fg: "yellow", blink: true, "data-testid": "slot-degraded" },
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
