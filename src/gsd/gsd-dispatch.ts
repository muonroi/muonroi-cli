import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdCoreLibDir, loadGsdLib } from "./gsd-runtime.js";

const require = createRequire(import.meta.url);

export interface GsdDispatchResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  raw?: string;
}

/** Resolve gsd-tools binary shipped with @opengsd/gsd-core. */
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
  return runGsdTools(cwd, ["init", "progress"]);
}

/** gsd-tools config-ensure-section — bootstrap .planning/config.json. */
export function dispatchConfigEnsure(cwd: string): GsdDispatchResult {
  return runGsdTools(cwd, ["config-ensure-section"]);
}

/** gsd-tools state update <field> <value> — uses gsd-core state-transition module. */
export function dispatchStateUpdate(cwd: string, field: string, value: string): GsdDispatchResult {
  return runGsdTools(cwd, ["state", "update", field, value]);
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
  const result = runGsdTools(cwd, ["state", "json"]);
  if (!result.ok) return result as GsdDispatchResult<Record<string, unknown>>;
  return { ok: true, data: result.data as Record<string, unknown>, raw: result.raw };
}

/** In-process loop hook resolution (no subprocess) — for tests and low-latency paths. */
export function resolveLoopHooksInProcess(
  cwd: string,
  point: string,
): { point: string; activeHooks: Array<Record<string, unknown>> } | null {
  try {
    const loopResolver = loadGsdLib<{
      resolveLoopHooks: (args: {
        point: string;
        registry: Record<string, unknown>;
        config: Record<string, unknown>;
      }) => { point: string; activeHooks: Array<Record<string, unknown>> };
    }>("loop-resolver");
    const configLoader = loadGsdLib<{ loadConfig: (c: string) => Record<string, unknown> }>("config-loader");
    const registry = loadGsdLib<Record<string, unknown>>("capability-registry");
    const config = configLoader.loadConfig(cwd);
    return loopResolver.resolveLoopHooks({ point, registry, config, cwd } as {
      point: string;
      registry: Record<string, unknown>;
      config: Record<string, unknown>;
      cwd: string;
    });
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

export function gsdCoreLibPath(): string {
  return gsdCoreLibDir();
}
