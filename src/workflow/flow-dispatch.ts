import { existsSync, statSync } from "node:fs";
import { REGISTRY } from "./capability-registry.js";
import { loadConfig } from "./config-loader.js";
import { resolveLoopHooks } from "./loop-resolver.js";
import {
  nativePhaseAdd,
  nativePhaseComplete,
  nativeRoadmapAnalyze,
  nativeRoadmapPlanProgress,
} from "./native-roadmap.js";
import { nativeConfigEnsure, nativeInitProgress, nativeStateJson, nativeStateUpdate } from "./native-state.js";
import { planningArtifact } from "./paths.js";

// Native Muonroi Flow dispatch. State, roadmap and loop hooks run in-process;
// the upstream native flag controls registration, never an external executable.

export interface FlowDispatchResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  raw?: string;
}

export interface LoopHooksEnvelope {
  point: string;
  activeHooks: Array<Record<string, unknown>>;
  rendered?: string;
  warnings?: string[];
}

/** Resolve Capability Registry hooks at a loop point (native in-process). */
export function dispatchLoopRenderHooks(cwd: string, point: string): FlowDispatchResult<LoopHooksEnvelope> {
  const native = resolveLoopHooksInProcess(cwd, point);
  if (!native) return { ok: false, error: `loop render-hooks(${point}) failed` };
  return { ok: true, data: { point: native.point, activeHooks: native.activeHooks } };
}

/** Milestone/phase progress JSON (native). */
export function dispatchInitProgress(cwd: string): FlowDispatchResult {
  return readThroughCache(cwd, "init.progress", () => ({ ok: true, data: nativeInitProgress(cwd) }));
}

/** Bootstrap .planning/ (native — the paired ensurePlanningWorkspace writes the real config). */
export function dispatchConfigEnsure(cwd: string): FlowDispatchResult {
  return { ok: true, data: nativeConfigEnsure(cwd) };
}

// ----- Per-cwd read-through cache for init.progress / state.json -----
// These subprocess outputs only change when STATE.md changes, so we memoise
// keyed on STATE.md mtime. Any in-process write (setStateField / dispatchStateUpdate)
// MUST call invalidateFlowCache(cwd) to prevent stale reads.

interface CacheEntry {
  stateMtimeMs: number;
  value: FlowDispatchResult;
}

const _dispatchCache = new Map<string, Map<string, CacheEntry>>();

function stateMtimeMs(cwd: string): number {
  try {
    const p = planningArtifact(cwd, "STATE.md");
    return existsSync(p) ? statSync(p).mtimeMs : 0;
  } catch {
    return 0;
  }
}

function readThroughCache(cwd: string, key: string, produce: () => FlowDispatchResult): FlowDispatchResult {
  const mtime = stateMtimeMs(cwd);
  let bucket = _dispatchCache.get(cwd);
  if (!bucket) {
    bucket = new Map();
    _dispatchCache.set(cwd, bucket);
  }
  const hit = bucket.get(key);
  if (hit && hit.stateMtimeMs === mtime) {
    return hit.value;
  }
  const value = produce();
  // Only cache successful reads — failures usually mean .planning/ absent;
  // caching them would mask a subsequent bootstrap.
  if (value.ok) {
    bucket.set(key, { stateMtimeMs: mtime, value });
  } else {
    bucket.delete(key);
  }
  return value;
}

/** Drop cached dispatch results for a cwd. Call after ANY write to STATE.md. */
export function invalidateFlowCache(cwd: string): void {
  _dispatchCache.delete(cwd);
}

/** state update <field> <value> — native STATE.md field replace. */
export function dispatchStateUpdate(cwd: string, field: string, value: string): FlowDispatchResult {
  const result: FlowDispatchResult = { ok: true, data: nativeStateUpdate(cwd, field, value) };
  // State writes mutate STATE.md → drop cached reads so the next dispatch
  // sees fresh data.
  invalidateFlowCache(cwd);
  return result;
}

export interface RoadmapPhaseEntry {
  number: string;
  name?: string;
  depends_on?: string | null;
  disk_status?: string;
}

export interface RoadmapAnalyzeResult {
  error?: string;
  phases?: RoadmapPhaseEntry[];
  phase_count?: number;
  current_phase?: string | null;
}

export interface PhaseAddResult {
  phaseNumber: string;
  rawStdout: string;
}

/** phase add <description> — creates .planning/phases/<NN>-<slug>/ (native). */
export function dispatchPhaseAdd(cwd: string, description: string): FlowDispatchResult<PhaseAddResult> {
  const sanitized = description.trim().slice(0, 120);
  const native = nativePhaseAdd(cwd, sanitized);
  if ("error" in native) return { ok: false, error: native.error };
  return { ok: true, data: { phaseNumber: native.padded, rawStdout: native.padded } };
}

/** phase complete <N> — marks milestone phase done (native). */
export function dispatchPhaseComplete(cwd: string, phaseNum: string): FlowDispatchResult {
  const num = phaseNum.replace(/^0+/, "") || phaseNum;
  const r = nativePhaseComplete(cwd, num);
  // STATE.md may have changed → drop cached reads.
  invalidateFlowCache(cwd);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: r };
}

/** roadmap update-plan-progress <N> — sync ROADMAP checkboxes (native). */
export function dispatchRoadmapPlanProgress(cwd: string, phaseNum: string): FlowDispatchResult {
  const num = phaseNum.replace(/^0+/, "") || phaseNum;
  const r = nativeRoadmapPlanProgress(cwd, num);
  // "no plans" / "ROADMAP missing" are soft (ok:true, updated:false); only
  // phase-not-found is a hard error.
  const hardFail = !r.updated && r.reason === `Phase ${num} not found`;
  return { ok: !hardFail, data: r, raw: r.raw };
}

/** roadmap analyze — parse ROADMAP.md + disk status (native, read-only). */
export function dispatchRoadmapAnalyze(cwd: string): FlowDispatchResult<RoadmapAnalyzeResult> {
  return { ok: true, data: nativeRoadmapAnalyze(cwd) as unknown as RoadmapAnalyzeResult };
}

/** state json — frontmatter snapshot (native derivation). */
export function dispatchStateJson(cwd: string): FlowDispatchResult<Record<string, unknown>> {
  return readThroughCache(cwd, "state.json", () => ({
    ok: true,
    data: nativeStateJson(cwd),
  })) as FlowDispatchResult<Record<string, unknown>>;
}

/**
 * In-process loop hook resolution — uses native modules instead of dynamic require().
 * For tests and low-latency paths. Replaces the old loadFlowLib() approach.
 */
export function resolveLoopHooksInProcess(
  cwd: string,
  point: string,
): { point: string; activeHooks: Array<Record<string, unknown>> } | null {
  try {
    const config = loadConfig(cwd);
    const resolved = resolveLoopHooks({ point, registry: REGISTRY, config, cwd });
    // Convert LoopHook[] to the broader array shape for backward compatibility
    const activeHooks = resolved.activeHooks as unknown as Array<Record<string, unknown>>;
    return { point: resolved.point, activeHooks };
  } catch (err) {
    console.error(`[flow-dispatch] resolveLoopHooksInProcess(${point}) failed: ${(err as Error).message}`);
    return null;
  }
}

/** Map muonroi task phase → flow STATE.md body field updates. */
export const PHASE_TO_FLOW_STATUS: Record<string, string> = {
  discuss: "Planning",
  plan: "Planning",
  execute: "In progress",
  verify: "In progress",
  review: "Phase complete",
  debug: "In progress",
};
