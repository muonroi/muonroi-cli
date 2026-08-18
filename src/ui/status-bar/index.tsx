/**
 * src/ui/status-bar/index.tsx
 *
 * OpenTUI status bar React component composing the 6 slots:
 * [provider/model] | [tier badge] | [in/out tokens session] | [USD session | month] | [degraded marker]
 *
 * Subscribes to statusBarStore for live updates (no polling).
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import * as React from "react";
import { type SprintProgressSegment, type StatusBarState, statusBarStore } from "../../state/status-bar-store.js";
import { computeCacheHitPct } from "./cache-hit.js";
import { TierBadge } from "./tier-badge.js";
import { UsdMeter } from "./usd-meter.js";

function useStatusBarState(): StatusBarState {
  const [s, set] = React.useState(statusBarStore.getState());
  React.useEffect(() => statusBarStore.subscribe(set), []);
  return s;
}

const EE_DOT: Record<string, { color: string; symbol: string }> = {
  ok: { color: "green", symbol: "●" }, // ●
  warn: { color: "yellow", symbol: "●" }, // ●
  down: { color: "red", symbol: "●" }, // ● configured but unreachable
  off: { color: "#555555", symbol: "◌" }, // ◌ not configured — connect via /ee setup
  unknown: { color: "gray", symbol: "○" }, // ○
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

/**
 * Format a SprintProgressSegment into the StatusBar display string.
 * Format: Sprint N/M · X/Y stories · Z%
 */
export function renderSprintSegment(s: SprintProgressSegment): string {
  return `Sprint ${s.activeSprintNumber}/${s.totalSprints} · ${s.completedStories}/${s.totalStories} stories · ${s.overallPct}%`;
}

/** Pure render function -- testable without React hooks context. */
export function renderStatusBar(s: StatusBarState): React.ReactElement {
  const modelLabel =
    s.routed_from && s.routed_from !== s.model
      ? `${s.provider || "-"}/${s.routed_from}→${s.model}`
      : `${s.provider || "-"}/${s.model || "-"}`;

  // F5 — show context fill % (latest call vs model window) so the user can
  // see how close they are to hitting the model's context limit, not just
  // the cumulative billed input.
  const ctxFill =
    s.ctx_pct !== undefined
      ? ` ctx${s.ctx_pct}%`
      : s.ctx_tokens !== undefined
        ? ` [ctx: ${fmtTokens(s.ctx_tokens)}]`
        : "";
  const hitPct = computeCacheHitPct(s);
  const cacheSeg = s.cache_read_tokens
    ? ` ⊚${fmtTokens(s.cache_read_tokens)}${hitPct !== null ? ` ${hitPct}%` : ""}`
    : "";
  const tokenStr = `↑${fmtTokens(s.in_tokens)} ↓${fmtTokens(s.out_tokens)}${cacheSeg}${ctxFill}`;
  const ee = EE_DOT[s.ee_status] ?? EE_DOT.unknown;

  const slots: React.ReactNode[] = [
    React.createElement("text", { key: "pm", fg: "#5c9cf5", "data-testid": "slot-provider-model" }, modelLabel),
    React.createElement(TierBadge, { key: "tier", tier: s.tier }),
    React.createElement(
      "text",
      { key: "tok", fg: "cyan", "data-testid": "slot-tokens" },
      `${tokenStr}${s.compaction_summary ? ` [${s.compaction_summary}]` : ""} ${fmtCost(s.session_usd)}`,
    ),
    React.createElement(UsdMeter, {
      key: "usd",
      session_usd: s.session_usd,
      current_pct: s.current_pct,
    }),
    React.createElement("text", { key: "ee", fg: ee.color, "data-testid": "slot-ee" }, ee.symbol),
  ];

  // Sprint progress segment (B1) — only shown when an /ideal run is active.
  if (s.sprint) {
    slots.push(
      React.createElement(
        "text",
        { key: "sprint", fg: "#a0e0a0", "data-testid": "slot-sprint" },
        renderSprintSegment(s.sprint),
      ),
    );
  }

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
export function StatusBar(): React.ReactNode {
  const s = useStatusBarState();
  const valueSummary = `${s.provider || "-"}/${s.model || "-"} ${s.degraded ? "DEGRADED" : "OK"}`;
  return (
    // biome-ignore lint/a11y/useValidAriaRole: statusbar is a valid ARIA role in the harness protocol, not a DOM element
    <Semantic id="status" role="statusbar" value={valueSummary} state={s.degraded ? "degraded" : undefined}>
      {renderStatusBar(s)}
    </Semantic>
  );
}
