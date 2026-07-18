/**
 * src/state/status-bar-store.ts
 *
 * Status bar store: subscribable atom holding model/provider/tier/tokens/USD/degraded.
 * wireStatusBar() connects to routerStore (Plan 03), subscribeThresholds (Plan 04),
 * and subscribeDowngrade (Plan 05).
 *
 * Presentation-agnostic state — lives outside src/ui so the headless core
 * (orchestrator/tool-engine/stream-runner) can read it without importing ui/.
 */

import { getCircuitState } from "../ee/client.js";
import { routerStore } from "../router/store.js";
import { subscribeDowngrade } from "../usage/downgrade.js";
import { subscribeThresholds } from "../usage/thresholds.js";
import { activeRunStore } from "./active-run.js";

export interface SprintProgressSegment {
  /** Active sprint index (1-based). */
  activeSprintNumber: number;
  /** Total number of sprints in the plan. */
  totalSprints: number;
  /** Completed stories in the active sprint. */
  completedStories: number;
  /** Total stories in the active sprint. */
  totalStories: number;
  /** Overall completion % across ALL sprints (0-100, 1 decimal). */
  overallPct: number;
}

export interface StatusBarState {
  provider: string;
  model: string;
  tier: "hot" | "warm" | "cold" | "degraded";
  in_tokens: number;
  out_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  session_usd: number;
  month_usd: number;
  cap_usd: number;
  current_pct: number;
  degraded: boolean;
  routed_from: string | null;
  /**
   * EE dot state. "off" = NOT CONFIGURED (no serverBaseUrl and the localhost
   * fallback doesn't answer) — visually distinct from "down" (configured but
   * unreachable) so "never connected" doesn't read as an outage.
   */
  ee_status: "ok" | "warn" | "down" | "off" | "unknown";
  ctx_tokens?: number;
  /** F5 — percent of model contextWindow filled by the latest call. */
  ctx_pct?: number;
  compaction_summary?: string;
  /** Sprint progress segment — present only while an /ideal run is active. */
  sprint?: SprintProgressSegment;
}

type Listener = (s: StatusBarState) => void;

function makeStore() {
  let state: StatusBarState = {
    provider: "",
    model: "",
    tier: "hot",
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    session_usd: 0,
    month_usd: 0,
    cap_usd: 0,
    current_pct: 0,
    degraded: false,
    routed_from: null,
    ee_status: "unknown",
    ctx_tokens: undefined,
  };
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState: (p: Partial<StatusBarState>) => {
      state = { ...state, ...p };
      for (const l of listeners) l(state);
    },
    subscribe: (fn: Listener) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const statusBarStore = makeStore();

let wired = false;

/**
 * Wire status bar to upstream stores.
 * Returns an unsubscribe-all function.
 * Idempotent -- second call is a no-op until the returned cleanup runs.
 */
export function wireStatusBar(): () => void {
  if (wired) return () => {};
  wired = true;

  const offRouter = routerStore.subscribe((rs) => {
    statusBarStore.setState({
      tier: rs.tier,
      degraded: rs.degraded,
      provider: rs.lastDecision?.provider ?? statusBarStore.getState().provider,
      model: rs.lastDecision?.model ?? statusBarStore.getState().model,
    });
  });

  const offThresholds = subscribeThresholds((ev) => {
    statusBarStore.setState({
      month_usd: ev.current_usd,
      cap_usd: ev.cap_usd,
      current_pct: ev.current_pct,
    });
  });

  const offDowngrade = subscribeDowngrade((ev) => {
    statusBarStore.setState({
      model: ev.toModel,
      current_pct: ev.pct,
    });
  });

  // EE health polling (every 30s) — reads config.json for server URL.
  // Re-read on every poll (not once at wire time) so a mid-session connect via
  // the EE connect card / `/ee config` flips the dot without a restart.
  let eeTimer: ReturnType<typeof setInterval> | null = null;

  function readEEConnection(): { baseUrl: string; authToken: string; configured: boolean } {
    let baseUrl = "http://127.0.0.1:8082";
    let authToken = "";
    let configured = false;
    try {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const cfgPath = path.join(os.homedir(), ".experience", "config.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg.serverBaseUrl) {
        baseUrl = cfg.serverBaseUrl;
        configured = true;
      }
      authToken = cfg.serverReadAuthToken || cfg.serverAuthToken || "";
    } catch {
      /* config unreadable — try localhost */
    }
    // Test/harness override mirrors getCachedServerBaseUrl(): counts as configured.
    const envOverride = process.env.MUONROI_EE_BASE_URL;
    if (envOverride) {
      baseUrl = envOverride;
      configured = true;
    }
    return { baseUrl, authToken, configured };
  }

  async function checkEEHealth() {
    const { baseUrl: eeBaseUrl, authToken: eeAuthToken, configured } = readEEConnection();
    try {
      const circuit = getCircuitState();
      // Circuit open → EE integration is effectively down in CLI.
      // Unconfigured + open circuit is still "off": there is nothing to be down.
      if (circuit === "open") {
        statusBarStore.setState({ ee_status: configured ? "down" : "off" });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const headers: Record<string, string> = {};
      if (eeAuthToken) headers.Authorization = `Bearer ${eeAuthToken}`;
      const res = await fetch(`${eeBaseUrl}/health`, { signal: controller.signal, headers });
      clearTimeout(timeout);
      if (res.ok) {
        // EE /health returns { ok: boolean } — treat undefined as ok on 200
        const data = (await res.json()) as { ok?: boolean };
        const serverOk = data.ok !== false;
        // Green only if: server healthy AND circuit closed (integration fully working)
        // Half-open means the circuit is probing again — if health passes, treat as ok
        statusBarStore.setState({
          ee_status: serverOk && (circuit === "closed" || circuit === "half-open") ? "ok" : "warn",
        });
      } else {
        statusBarStore.setState({ ee_status: "warn" });
      }
    } catch {
      // Unreachable: configured server → "down" (outage); no config and the
      // localhost fallback silent → "off" (never connected — see EE connect card).
      statusBarStore.setState({ ee_status: configured ? "down" : "off" });
    }
  }
  checkEEHealth();
  eeTimer = setInterval(checkEEHealth, 30_000);

  // ── Sprint progress polling (B1) ───────────────────────────────────────────
  // Cache the last-read snapshot so we don't hit disk on every 5s tick when
  // nothing has changed. Invalidated by active-run subscription on sprint_stage.
  let sprintSnapshotDirty = false;
  let sprintPollTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshSprintProgress(): Promise<void> {
    const run = activeRunStore.getState();
    if (!run.runId || !run.flowDir) {
      statusBarStore.setState({ sprint: undefined });
      return;
    }
    try {
      // Lazy import to avoid circular dependency at module load time.
      const { readBacklog } = await import("../product-loop/backlog-store.js");
      const { readSprintPlan } = await import("../product-loop/sprint-store.js");
      const [backlog, sprintPlan] = await Promise.all([
        readBacklog(run.flowDir, run.runId).catch(() => null),
        readSprintPlan(run.flowDir, run.runId).catch(() => null),
      ]);

      if (!sprintPlan || sprintPlan.sprints.length === 0) {
        statusBarStore.setState({ sprint: undefined });
        return;
      }

      const activeSprint = sprintPlan.activeSprintId
        ? (sprintPlan.sprints.find((s) => s.id === sprintPlan.activeSprintId) ?? null)
        : null;

      // Overall completion: all done items across all sprints / all items in all sprints
      const allItemIds = sprintPlan.sprints.flatMap((s) => s.itemIds);
      const allItems = backlog
        ? allItemIds
            .map((id) => backlog.items.find((i) => i.id === id))
            .filter((i): i is NonNullable<typeof i> => i !== undefined)
        : [];
      const totalAllItems = allItems.length;
      const doneAllItems = allItems.filter((i) => i.status === "done").length;
      const overallPct = totalAllItems > 0 ? Math.round((doneAllItems / totalAllItems) * 1000) / 10 : 0;

      if (!activeSprint) {
        // No active sprint but plan exists — show total/overall only.
        statusBarStore.setState({
          sprint: {
            activeSprintNumber: sprintPlan.sprints.length,
            totalSprints: sprintPlan.sprints.length,
            completedStories: doneAllItems,
            totalStories: totalAllItems,
            overallPct,
          },
        });
        return;
      }

      const activeItems = backlog
        ? activeSprint.itemIds
            .map((id) => backlog.items.find((i) => i.id === id))
            .filter((i): i is NonNullable<typeof i> => i !== undefined)
        : [];
      const completedStories = activeItems.filter((i) => i.status === "done").length;

      statusBarStore.setState({
        sprint: {
          activeSprintNumber: activeSprint.number,
          totalSprints: sprintPlan.sprints.length,
          completedStories,
          totalStories: activeItems.length,
          overallPct,
        },
      });
    } catch {
      // Non-fatal — hide the segment rather than crash
      statusBarStore.setState({ sprint: undefined });
    }
  }

  // Subscribe to active-run changes: immediately refresh on run start/end.
  const offActiveRun = activeRunStore.subscribe(() => {
    sprintSnapshotDirty = true;
    void refreshSprintProgress();
  });

  // Also subscribe to global sprint_stage events to invalidate cache.
  // We tap the same globalThis.__muonroiAgentRuntime emitEvent that the harness uses,
  // but since we're in a module-level function we register a listener via a
  // lightweight per-process event bus instead.
  const sprintStageHandler = (e: unknown): void => {
    if (!e || typeof e !== "object") return;
    const ev = e as Record<string, unknown>;
    if (ev.t === "event" && (ev.kind === "sprint-stage" || ev.kind === "sprint_stage")) {
      sprintSnapshotDirty = true;
      void refreshSprintProgress();
    }
  };

  // Register on the global event bus if available.
  const globals = globalThis as Record<string, unknown>;
  const existingRuntime = globals.__muonroiAgentRuntime as { emitEvent?: (e: unknown) => void } | undefined;
  let patchedEmit: ((e: unknown) => void) | null = null;
  let originalEmit: ((e: unknown) => void) | null = null;
  if (existingRuntime && typeof existingRuntime.emitEvent === "function") {
    originalEmit = existingRuntime.emitEvent.bind(existingRuntime);
    patchedEmit = (e: unknown) => {
      sprintStageHandler(e);
      (originalEmit as (e: unknown) => void)(e);
    };
    existingRuntime.emitEvent = patchedEmit;
  }

  // Fallback 5s poll for environments without the harness event bus.
  sprintPollTimer = setInterval(() => {
    if (sprintSnapshotDirty || activeRunStore.getState().runId) {
      sprintSnapshotDirty = false;
      void refreshSprintProgress();
    }
  }, 5_000);

  // Initial load.
  void refreshSprintProgress();

  return () => {
    offRouter();
    offThresholds();
    offDowngrade();
    offActiveRun();
    if (eeTimer) clearInterval(eeTimer);
    if (sprintPollTimer) clearInterval(sprintPollTimer);
    // Restore original emitEvent if we patched it.
    if (patchedEmit && originalEmit && existingRuntime && existingRuntime.emitEvent === patchedEmit) {
      existingRuntime.emitEvent = originalEmit;
    }
    wired = false;
  };
}

/** Test helper: reset store to default state. */
export function __resetStatusBarStoreForTests(): void {
  statusBarStore.setState({
    provider: "",
    model: "",
    tier: "hot",
    in_tokens: 0,
    out_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    session_usd: 0,
    month_usd: 0,
    cap_usd: 0,
    current_pct: 0,
    degraded: false,
    routed_from: null,
    ee_status: "unknown",
    ctx_tokens: undefined,
    sprint: undefined,
  });
  wired = false;
}
