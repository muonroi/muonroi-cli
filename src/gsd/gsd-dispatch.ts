import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REGISTRY } from "./capability-registry.js";
import { loadConfig } from "./config-loader.js";
import { resolveLoopHooks } from "./loop-resolver.js";
import { planningArtifact } from "./paths.js";

const require = createRequire(import.meta.url);

export interface GsdDispatchResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  raw?: string;
}

/**
 * Resolve gsd-tools binary shipped with @opengsd/gsd-core.
 * TODO(sprint 2): remove this dep when gsd-tools.cjs is natively reimplemented.
 */
export function resolveGsdToolsBin(): string {
  const pkgJson = require.resolve("@opengsd/gsd-core/package.json");
  return join(dirname(pkgJson), "gsd-core", "bin", "gsd-tools.cjs");
}

const PLAIN_TEXT_OK = new Set(["exists", "created", "updated", "ok"]);

function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (PLAIN_TEXT_OK.has(trimmed.toLowerCase())) {
    return { status: trimmed.toLowerCase() };
  }
  if (/^\d{1,3}$/.test(trimmed)) {
    return { phaseNumber: trimmed, raw: trimmed };
  }
  if (/^\d+\/\d+\s+\w+$/i.test(trimmed)) {
    return { progress: trimmed, raw: trimmed };
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (err) {
    console.error(`[gsd-dispatch] JSON parse failed: ${(err as Error).message}; stdout=${trimmed.slice(0, 200)}`);
    return { raw: trimmed };
  }
}

/**
 * Run gsd-tools subcommand. Always appends --raw for machine-readable JSON when supported.
 * Never throws — returns { ok: false } on failure.
 */
export function runGsdTools(cwd: string, args: string[], timeoutMs = 30_000): GsdDispatchResult {
  const bin = resolveGsdToolsBin();
  const withRaw = args.includes("--raw") ? args : [...args, "--raw"];
  try {
    const stdout = execFileSync(process.execPath, [bin, ...withRaw], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const data = parseJsonStdout(stdout);
    return { ok: true, data, raw: stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const msg = e.stderr?.trim() || e.message || "gsd-tools failed";
    console.error(`[gsd-dispatch] ${withRaw.join(" ")} failed: ${msg}`);
    return { ok: false, error: msg, raw: e.stdout };
  }
}

export interface LoopHooksEnvelope {
  point: string;
  activeHooks: Array<Record<string, unknown>>;
  rendered?: string;
  warnings?: string[];
}

/** gsd-tools loop render-hooks <point> — resolves Capability Registry hooks at a loop point. */
export function dispatchLoopRenderHooks(cwd: string, point: string): GsdDispatchResult<LoopHooksEnvelope> {
  const result = runGsdTools(cwd, ["loop", "render-hooks", point]);
  if (!result.ok) return result as GsdDispatchResult<LoopHooksEnvelope>;
  return { ok: true, data: result.data as LoopHooksEnvelope, raw: result.raw };
}

/** gsd-tools init progress — milestone/phase progress JSON. */
export function dispatchInitProgress(cwd: string): GsdDispatchResult {
  return readThroughCache(cwd, "init.progress", () => runGsdTools(cwd, ["init", "progress"]));
}

/** gsd-tools config-ensure-section — bootstrap .planning/config.json. */
export function dispatchConfigEnsure(cwd: string): GsdDispatchResult {
  return runGsdTools(cwd, ["config-ensure-section"]);
}

// ----- Per-cwd read-through cache for init.progress / state.json -----
// These subprocess outputs only change when STATE.md changes, so we memoise
// keyed on STATE.md mtime. Any in-process write (setStateField / dispatchStateUpdate)
// MUST call invalidateGsdCache(cwd) to prevent stale reads.

interface CacheEntry {
  stateMtimeMs: number;
  value: GsdDispatchResult;
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

function readThroughCache(cwd: string, key: string, produce: () => GsdDispatchResult): GsdDispatchResult {
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
export function invalidateGsdCache(cwd: string): void {
  _dispatchCache.delete(cwd);
}

/** gsd-tools state update <field> <value> — uses gsd-core state-transition module. */
export function dispatchStateUpdate(cwd: string, field: string, value: string): GsdDispatchResult {
  const result = runGsdTools(cwd, ["state", "update", field, value]);
  // State writes mutate STATE.md → drop cached reads so the next dispatch
  // sees fresh data.
  invalidateGsdCache(cwd);
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

/** Parse plain-text stdout from `phase add --raw` (e.g. "02"). */
export function parsePhaseAddStdout(raw: string | undefined): PhaseAddResult | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{1,3})$/);
  if (match) return { phaseNumber: match[1]!, rawStdout: trimmed };
  const data = parseJsonStdout(trimmed);
  if (data && typeof data === "object" && data !== null && "padded" in data) {
    const padded = String((data as { padded: unknown }).padded).trim();
    const m = padded.match(/^(\d{1,3})$/);
    if (m) return { phaseNumber: m[1]!, rawStdout: trimmed };
  }
  return null;
}

/** gsd-tools phase add <description> — creates .planning/phases/<NN>-<slug>/ */
export function dispatchPhaseAdd(cwd: string, description: string): GsdDispatchResult<PhaseAddResult> {
  const sanitized = description.trim().slice(0, 120);
  const result = runGsdTools(cwd, ["phase", "add", sanitized]);
  if (!result.ok) return result as GsdDispatchResult<PhaseAddResult>;
  const parsed = parsePhaseAddStdout(result.raw ?? String(result.data ?? ""));
  if (!parsed) {
    return { ok: false, error: `phase add returned unparseable stdout: ${result.raw?.slice(0, 80)}`, raw: result.raw };
  }
  return { ok: true, data: parsed, raw: result.raw };
}

/** gsd-tools phase complete <N> — marks milestone phase done. */
export function dispatchPhaseComplete(cwd: string, phaseNum: string): GsdDispatchResult {
  const num = phaseNum.replace(/^0+/, "") || phaseNum;
  return runGsdTools(cwd, ["phase", "complete", num]);
}

/** gsd-tools roadmap update-plan-progress <N> — sync ROADMAP checkboxes. */
export function dispatchRoadmapPlanProgress(cwd: string, phaseNum: string): GsdDispatchResult {
  const num = phaseNum.replace(/^0+/, "") || phaseNum;
  return runGsdTools(cwd, ["roadmap", "update-plan-progress", num]);
}

/** gsd-tools roadmap analyze — parse ROADMAP.md + disk status. */
export function dispatchRoadmapAnalyze(cwd: string): GsdDispatchResult<RoadmapAnalyzeResult> {
  const result = runGsdTools(cwd, ["roadmap", "analyze"]);
  if (!result.ok) return result as GsdDispatchResult<RoadmapAnalyzeResult>;
  return { ok: true, data: result.data as RoadmapAnalyzeResult, raw: result.raw };
}

/** gsd-tools state json — frontmatter snapshot. */
export function dispatchStateJson(cwd: string): GsdDispatchResult<Record<string, unknown>> {
  return readThroughCache(cwd, "state.json", () => {
    const result = runGsdTools(cwd, ["state", "json"]);
    if (!result.ok) return result as GsdDispatchResult<Record<string, unknown>>;
    return { ok: true, data: result.data as Record<string, unknown>, raw: result.raw };
  }) as GsdDispatchResult<Record<string, unknown>>;
}

/**
 * In-process loop hook resolution — uses native modules instead of dynamic require().
 * For tests and low-latency paths. Replaces the old loadGsdLib() approach.
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
    console.error(`[gsd-dispatch] resolveLoopHooksInProcess(${point}) failed: ${(err as Error).message}`);
    return null;
  }
}

/** Map muonroi task phase → gsd STATE.md body field updates. */
export const PHASE_TO_GSD_STATUS: Record<string, string> = {
  discuss: "Planning",
  plan: "Planning",
  execute: "In progress",
  verify: "In progress",
  review: "Phase complete",
  debug: "In progress",
};
