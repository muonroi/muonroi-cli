/** Two fixed footer rows: operating state, then workspace and current-run usage. */
import { Semantic } from "@muonroi/agent-harness-opentui";
import * as React from "react";
import { type SprintProgressSegment, type StatusBarState, statusBarStore } from "../../state/status-bar-store.js";
import { computeCacheHitPct } from "./cache-hit.js";
import { UsdMeter } from "./usd-meter.js";

function useStatusBarState(): StatusBarState {
  const [s, set] = React.useState(statusBarStore.getState());
  React.useEffect(() => statusBarStore.subscribe(set), []);
  return s;
}
const EE_COLORS = { ok: "green", warn: "yellow", down: "red", off: "#777777", unknown: "gray" };
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
export function renderSprintSegment(s: SprintProgressSegment): string {
  return `Sprint ${s.activeSprintNumber}/${s.totalSprints} · ${s.completedStories}/${s.totalStories} stories · ${s.overallPct}%`;
}
export interface StatusBarProps {
  width?: number;
  cwd?: string;
  sandbox?: boolean;
  version?: string;
}
interface Segment {
  id: string;
  text: string;
  color: string;
}

/** ASCII labels use a cell budget; OpenTUI truncates Unicode paths/models. */
export function footerSegments(s: StatusBarState, width: number) {
  const primary: Segment[] = [];
  if (s.degraded || s.tier === "degraded") primary.push({ id: "degraded", text: "DEGRADED", color: "yellow" });
  if (s.permission_mode)
    primary.push({
      id: "permission-mode",
      text: s.permission_mode === "auto-edit" ? "Auto-edit" : s.permission_mode === "yolo" ? "Yolo" : "Safe",
      color: s.permission_mode === "yolo" ? "yellow" : "gray",
    });
  if (width >= 100 && s.routing_mode)
    primary.push({
      id: "routing-mode",
      text: `Workers: ${s.routing_mode[0].toUpperCase()}${s.routing_mode.slice(1)}`,
      color: "gray",
    });
  if (width >= 120) primary.push({ id: "ee", text: `EE ${s.ee_status}`, color: EE_COLORS[s.ee_status] });
  const hit = computeCacheHitPct(s);
  const secondary: Segment[] = [
    {
      id: "context",
      text: `Context ${s.ctx_pct !== undefined ? `${s.ctx_pct}%` : s.ctx_tokens !== undefined ? fmtTokens(s.ctx_tokens) : "—"}`,
      color: "gray",
    },
    { id: "cache", text: `Cache hit ${hit === null ? "—" : `${hit}%`}`, color: "gray" },
  ];
  if (width >= 110)
    secondary.push({ id: "tokens", text: `Run ↑${fmtTokens(s.in_tokens)} ↓${fmtTokens(s.out_tokens)}`, color: "gray" });
  const compactions = s.compaction_summary?.match(/^(\d+) cmp\b/);
  if (width >= 140 && compactions)
    secondary.push({
      id: "compaction",
      text: `Compact ${compactions[1]}${s.compaction_summary?.includes("long session") ? " · Long session" : ""}`,
      color: "gray",
    });
  if (width >= 170 && s.sprint) secondary.push({ id: "sprint", text: renderSprintSegment(s.sprint), color: "#a0e0a0" });
  while (secondary.length > 2 && secondary.reduce((n, part) => n + part.text.length + 3, 0) > width - 24)
    secondary.pop();
  return { primary, secondary };
}
const lineProps = {
  height: 1,
  minHeight: 1,
  maxHeight: 1,
  flexShrink: 0,
  flexDirection: "row" as const,
  overflow: "hidden" as const,
};
const textProps = { height: 1, wrapMode: "none" as const, truncate: true };
function fixedSegment(segment: Segment) {
  return React.createElement(
    "text",
    { ...textProps, key: segment.id, flexShrink: 0, fg: segment.color, "data-testid": `slot-${segment.id}` },
    ` · ${segment.text}`,
  );
}
export function renderStatusBar(
  s: StatusBarState,
  { width = 180, cwd = "", sandbox = false, version }: StatusBarProps = {},
): React.ReactElement {
  const available = Math.max(1, width);
  const { primary, secondary } = footerSegments(s, available);
  const primaryBudget = primary.reduce((n, part) => n + part.text.length + 3, 0);
  const costWidth = `Run $${s.session_usd.toFixed(2)}`.length;
  const identityWidth = Math.max(1, available - primaryBudget - costWidth - 2);
  const metricsWidth = secondary.reduce((n, part) => n + part.text.length + 3, 0);
  const model = available < 100 ? s.model || "-" : `${s.provider || "-"}/${s.model || "-"}`;
  const identity = `${available < 100 ? "Orch" : "Orchestrator"} ${model}`;
  return React.createElement(
    "box",
    { "data-testid": "status-bar", width: available, height: 2, flexDirection: "column", flexShrink: 0 },
    React.createElement(
      "box",
      { ...lineProps, width: available, key: "operation", "data-testid": "footer-operation" },
      React.createElement(
        "text",
        { ...textProps, width: identityWidth, fg: "#5c9cf5", "data-testid": "slot-provider-model" },
        identity,
      ),
      ...primary.map(fixedSegment),
      React.createElement("box", { flexGrow: 1, minWidth: 0 }),
      React.createElement(UsdMeter, {
        key: "usd",
        session_usd: s.session_usd,
        current_pct: s.current_pct,
        label: "Run",
      }),
    ),
    React.createElement(
      "box",
      { ...lineProps, width: available, key: "usage", "data-testid": "footer-usage" },
      React.createElement(
        "text",
        { ...textProps, width: Math.max(1, available - metricsWidth), fg: "#777777", "data-testid": "slot-workspace" },
        `${cwd}${sandbox ? " · sandbox" : ""}${version && available >= 200 ? ` · v${version}` : ""}`,
      ),
      ...secondary.map(fixedSegment),
    ),
  );
}
export function StatusBar(props: StatusBarProps): React.ReactNode {
  const s = useStatusBarState();
  const valueSummary = `${s.provider || "-"}/${s.model || "-"} ${s.degraded ? "DEGRADED" : "OK"}${s.routing_mode ? ` routing=${s.routing_mode}` : ""}; current run input=${s.in_tokens} cached=${s.cache_read_tokens}; ${s.compaction_summary ?? ""}`;
  return (
    // biome-ignore lint/a11y/useValidAriaRole: statusbar is a harness protocol role
    <Semantic id="status" role="statusbar" value={valueSummary} state={s.degraded ? "degraded" : undefined}>
      {renderStatusBar(s, props)}
    </Semantic>
  );
}
