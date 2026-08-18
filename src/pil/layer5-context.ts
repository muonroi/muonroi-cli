import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getWhoAmIProfile, searchByText } from "../ee/bridge.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

// WhoAmI v4.0 (wired): `work_patterns.session_length` (short|medium|long), reachable
// via ../ee/bridge.js → who-am-i.ts, tunes the resume-digest staleness window below.
// TODO(WhoAmI-L5): `work_patterns.multitasking` (sequential-deep | task-switcher) IS
// also emitted and could tune recall freshness similarly — deferred until measured.
// Also: deduplicate with L3 — if L3 already injected experience-principles, skip that
// collection here to avoid double-injection.
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

// session_length → resume-digest staleness window. Long deep-work sessions keep a
// resume digest relevant longer (relax to 60m); short bursts go stale sooner (tighten
// to 15m). medium / absent → the 30m default, so a machine with no committed
// session_length dim (the common case — needs N>=10 sessions) behaves byte-identically
// to pre-v4.0: zero regression. Pure + exported for deterministic unit testing.
export function staleThresholdMsForSessionLength(value: string | undefined | null): number {
  if (value === "long") return 60 * 60 * 1000;
  if (value === "short") return 15 * 60 * 1000;
  return STALE_THRESHOLD_MS;
}

// Single round-trip for both collections via /api/search; topK=5 yields
// up to 2 principles + 3 behavioral after server-side scoring.
const LAYER5_SEARCH_TIMEOUT_MS = 1500;

// Score floor — points below this are dropped as noise. Same default and
// override knob as Layer 3 to keep behaviour consistent across PIL.
const LAYER5_SCORE_FLOOR = (() => {
  const raw = Number(process.env.MUONROI_PIL_SCORE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.55;
})();

async function fetchPrinciples(raw: string, budget: number): Promise<string> {
  try {
    const points = await searchByText(
      raw,
      ["experience-principles", "experience-behavioral"],
      5,
      AbortSignal.timeout(LAYER5_SEARCH_TIMEOUT_MS),
    );
    const filtered = points.filter((p) => (p.score ?? 0) >= LAYER5_SCORE_FLOOR);
    if (filtered.length === 0) return "";
    const sorted = filtered.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const lines = sorted.map((p) => {
      const payload = p.payload as { text?: string; json?: string } | undefined;
      const text = payload?.text ?? (payload?.json ? (JSON.parse(payload.json) as { solution?: string }).solution : "");
      return `- ${String(text ?? "").slice(0, 120)}`;
    });
    return truncateToBudget(`[principles: Always-loaded experience]\n${lines.join("\n")}`, budget);
  } catch {
    return "";
  }
}

async function fetchFlowState(cwd: string, budget: number): Promise<string> {
  try {
    // Canonical focus pointer: `state.md` `Active Run` (run-manager). The old
    // `.muonroi-flow/active-run` file had no writer in src and always read stale
    // (F8 follow-up: dropped that dead path in favor of the single source).
    const { getActiveRunId } = await import("../flow/run-manager.js");
    const flowDir = path.join(cwd, ".muonroi-flow");
    const runId = await getActiveRunId(flowDir);
    if (!runId) return "";
    const statePath = path.join(flowDir, "runs", runId, "state.md");
    const state = await fs.readFile(statePath, "utf8");
    const phaseLine = state.match(/phase:\s*(.+)/i)?.[1]?.trim() ?? "unknown";
    const statusLine = state.match(/status:\s*(.+)/i)?.[1]?.trim() ?? "unknown";
    return truncateToBudget(`[flow: phase=${phaseLine}, status=${statusLine}, run=${runId}]`, budget);
  } catch {
    return "";
  }
}

async function fetchRecentFiles(cwd: string, budget: number): Promise<string> {
  try {
    const srcDir = path.join(cwd, "src");
    const entries = await fs.readdir(srcDir, { recursive: true, withFileTypes: true });
    const tsFiles: Array<{ name: string; mtime: number }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".ts") && !e.name.endsWith(".tsx")) continue;
      if (e.name.includes(".test.") || e.name.includes("__test")) continue;
      const full = path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
      const stat = await fs.stat(full);
      tsFiles.push({ name: path.relative(srcDir, full).replace(/\\/g, "/"), mtime: stat.mtimeMs });
    }
    tsFiles.sort((a, b) => b.mtime - a.mtime);
    const top = tsFiles.slice(0, 10).map((f) => f.name);
    if (top.length === 0) return "";
    return truncateToBudget(`[recent-files: ${top.join(", ")}]`, budget);
  } catch {
    return "";
  }
}

export async function layer5Context(ctx: PipelineContext): Promise<PipelineContext> {
  // Chitchat short-circuit: greetings/small-talk don't need workspace context
  // (recent-files, flow-state, principles). Inject nothing — keep the model's
  // attention on a 5-character prompt instead of a 30K-token tool catalog.
  if (ctx.intentKind === "chitchat") {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "context-enrichment", applied: false, delta: "skip:chitchat" }],
    };
  }

  const cwd = process.cwd();
  const parts: string[] = [];
  const deltaSegments: string[] = [];

  // 1. T0/T1 principles — skip when L1's unified call already supplied them
  //    (L3 already rendered the principles block from ctx._brainData).
  if (!ctx._brainData) {
    const principlesBudget = Math.floor(ctx.tokenBudget * 0.12);
    const principles = await fetchPrinciples(ctx.raw, principlesBudget);
    if (principles) {
      parts.push(principles);
      deltaSegments.push(`principles=${principles.length}ch`);
    }
  } else {
    deltaSegments.push("principles=skipped-l1-unified");
  }

  // 2. Resume digest (5% budget). Staleness window is profile-tuned by session_length
  //    (fail-open: absent dim → 30m default, identical to pre-v4.0). getWhoAmIProfile
  //    is cached + fail-open, so this never adds latency or a failure path here.
  const digest = ctx.resumeDigest;
  if (digest?.trim()) {
    const staleMs = staleThresholdMsForSessionLength(getWhoAmIProfile()?.dims["work_patterns.session_length"]?.value);
    const isStale = typeof ctx.digestAgeMs === "number" && ctx.digestAgeMs > staleMs;
    const stalePrefix = isStale ? "(stale — verify before relying)\n" : "";
    const hint = `[flow-context: Resume]\n${stalePrefix}${digest.trim()}`;
    const trimmed = truncateToBudget(hint, Math.floor(ctx.tokenBudget * 0.05));
    parts.push(trimmed);
    const windowTag = staleMs !== STALE_THRESHOLD_MS ? `,window=${staleMs / 60000}m` : "";
    deltaSegments.push(`digest=${trimmed.length}ch${isStale ? ",stale" : ""}${windowTag}`);
  }

  // 3. Flow state (5% budget)
  const flowBudget = Math.floor(ctx.tokenBudget * 0.05);
  const flowState = await fetchFlowState(cwd, flowBudget);
  if (flowState) {
    parts.push(flowState);
    deltaSegments.push(`flow=${flowState.length}ch`);
  }

  // 4. Recent file index (3% budget)
  // PIL-L6 fix — skip recent-files for operational tasks (CI/build/deploy).
  // Session bca83bcbaad1 logged the inject pulling agent into reading
  // providers/runtime.ts + mock-model.ts when the real task was just
  // "gh run view --log-failed". Recent-files biases narrow-scope tasks.
  const skipRecentFiles = /\b(ci|cd|build|deploy(?:ment)?|action(?:s)?|workflow|pipeline|gh\s+(check|run))\b/i.test(
    ctx.raw,
  );
  if (!skipRecentFiles && ctx.scopeKind !== "external") {
    const filesBudget = Math.floor(ctx.tokenBudget * 0.03);
    const fileIndex = await fetchRecentFiles(cwd, filesBudget);
    if (fileIndex) {
      parts.push(fileIndex);
      deltaSegments.push(`files=${fileIndex.length}ch`);
    }
  } else {
    deltaSegments.push(ctx.scopeKind === "external" ? "files=skipped-external" : "files=skipped-operational");
  }

  if (parts.length === 0) {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "context-enrichment", applied: false, delta: "no-context-sources" }],
    };
  }

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${parts.join("\n")}`,
    layers: [
      ...ctx.layers,
      {
        name: "context-enrichment",
        applied: true,
        delta: deltaSegments.join(" "),
      },
    ],
  };
}
