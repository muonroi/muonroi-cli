/**
 * src/pil/layer3-ee-injection.ts
 *
 * PIL Layer 3 — Experience Engine injection.
 *
 * Thin-client aware: when `serverBaseUrl` is configured in ~/.experience/config.json
 * `searchByText` issues a single `/api/search` round-trip (server embeds + Qdrant
 * search server-side). Otherwise falls back to in-process embed + Qdrant.
 *
 * ## BB dedup (shared contract with src/ee/bb-retrieval.ts)
 * Before appending any EE hit this layer scans `ctx.enriched` for
 * `<!-- bb-context-injected:<sha16> -->` markers written by bb-retrieval.ts.
 * When the computed sha of an EE hit payload matches a marker already present,
 * the hit is skipped — preventing double-injection when both CB-1 (loop-driver)
 * and PIL Layer 3 are active on the same pipeline run.
 */

import { createHash } from "node:crypto";
import type { EEPoint } from "../ee/bridge.js";
import { searchByText } from "../ee/bridge.js";
import { updateLastSurfacedState } from "../ee/intercept.js";
import { formatPendingReminder, isRecallLedgerEnabled, sessionRecallLedger } from "../ee/recall-ledger.js";
import { getRenderSink } from "../ee/render.js";
import { PLANNING_CHECKPOINT_QUERY } from "../gsd/ee-closure.js";
import { isGsdNativeEnabled } from "../gsd/flags.js";
import { logInteraction } from "../storage/interaction-log.js";
import { classifyEeError, logEeFailure, readTimeoutEnv } from "../utils/ee-logger.js";
import { truncateToBudget } from "./budget.js";
import type { PipelineContext } from "./types.js";

/**
 * Session-scoped cross-turn dedup: records which pending recall IDs have
 * already been surfaced via the feedback nudge in a previous turn. Prevents
 * the same unrated [id] list from consuming input tokens turn after turn.
 * Cleared on session reset (process exit or ledger.reset()).
 */
const _surfacedPendingIds = new Map<string, Set<string>>();

// Budget for the HTTP/in-process search round-trip. 60ms (legacy) was tuned for
// localhost Ollama and routinely tripped the abort on VPS thin-client setups
// where embedding goes through SiliconFlow.
//
// Phase 21 / Plan 02 / T4: overridable via `MUONROI_PIL_SEARCH_TIMEOUT_MS` env
// (clamped to [500, 5000]).
const PIL_SEARCH_TIMEOUT_MS = readTimeoutEnv("MUONROI_PIL_SEARCH_TIMEOUT_MS", 1500, 500, 5000);

// Score floor — points scoring below this are treated as noise and dropped
// before injection. Mirrors the server-side `minConfidence` (0.55) used by
// the intercept path so the brain doesn't pollute prompts with weak hits.
// Set MUONROI_PIL_SCORE_FLOOR=<number> to override per-machine.
const PIL_SCORE_FLOOR = (() => {
  const raw = Number(process.env.MUONROI_PIL_SCORE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.55;
})();

// T0 principles use a lower floor because they are pre-validated abstractions
// from the evolution engine (cluster → abstract lifecycle). They are less
// prompt-specific than behavioral patterns, so a lower cosine threshold is
// acceptable — relevance comes from the principle's generality, not from
// exact wording matching the current prompt.
const PIL_PRINCIPLES_FLOOR = Math.max(0, PIL_SCORE_FLOOR - 0.15);

// hitCount threshold for promoting a behavioral point to T1 "proven" reflex.
// Mirrors the EE evolution promotion rule (3 confirmed hits → T1).
const T1_HIT_THRESHOLD = 3;

/**
 * Inline reminder appended to the injected experience block (when rateable
 * principles/behavioral are present) so passively-injected recalls carry a
 * feedback prompt next to their [id:..] handles — the front-loaded
 * native-capabilities instruction can be compacted away on long sessions, and
 * unrated recalls degrade future recall (the recall arm of the EE loop is
 * explicit-feedback-only by design).
 */
export const RECALL_FEEDBACK_NUDGE =
  "↳ Acted on one of the above [id:..]? Rate it: ee_feedback(id, followed|ignored|noise). Unrated recalls degrade future recall.";

/**
 * Extract all sha16 values from `<!-- bb-context-injected:<sha16> -->` markers
 * already present in the enriched context string.
 */
function extractBBMarkerShas(enriched: string): Set<string> {
  const shas = new Set<string>();
  const regex = /<!-- bb-context-injected:([0-9a-f]{16}) -->/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(enriched)) !== null) {
    shas.add(m[1]);
  }
  return shas;
}

/**
 * Phase 3 full implementation: dedicated extractor for compaction checkpoint markers.
 * Mirrors BB contract but uses distinct marker so checkpoints can be deduped independently
 * of principles/behavioral and BB-injected context.
 */
function extractCheckpointMarkerShas(enriched: string): Set<string> {
  const shas = new Set<string>();
  const regex = /<!-- ee-checkpoint-injected:([0-9a-f]{16}) -->/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(enriched)) !== null) {
    shas.add(m[1]);
  }
  return shas;
}

/**
 * Compute sha16 for a payload text (mirrors bbContextMarker in bb-retrieval.ts).
 * Used to check whether an EE hit payload was already injected by the BB path.
 */
function payloadSha16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Server-side `/api/search` whitelist (experience-engine/server.js):
//   experience-behavioral  — extracted behavioral patterns (T1/T2, seeded by evolve/extract)
//   experience-principles  — abstracted principles (T0, seeded by evolution-abstraction)
// experience-routes / experience-selfqa are intentionally NOT exposed.

function extractPointText(p: EEPoint): string {
  const payload = p.payload ?? {};
  const text = (payload.text as string) ?? "";
  if (text) return text;
  try {
    const parsed = JSON.parse((payload.json as string) || "{}") as {
      solution?: string;
      principle?: string;
      judgment?: string;
      progress?: string;
      summary?: string;
    };
    if (parsed.progress || parsed.summary) return (parsed.progress ?? parsed.summary ?? "") as string;
    return parsed.solution ?? parsed.principle ?? parsed.judgment ?? "";
  } catch {
    return "";
  }
}

function isT1Proven(p: EEPoint): boolean {
  try {
    const parsed = JSON.parse((p.payload?.json as string) || "{}") as {
      tier?: string;
      hitCount?: number;
    };
    // Checkpoints from compaction (ee-anti-mu) are injected via formatTaskCheckpoints regardless of T1 tier.
    return parsed.tier === "proven" || (parsed.hitCount ?? 0) >= T1_HIT_THRESHOLD;
  } catch {
    return false;
  }
}

interface BridgeResult {
  principlePoints: EEPoint[];
  behavioralPoints: EEPoint[];
  t1Rules: string[];
  checkpointPoints: EEPoint[];
  error?: string;
  filtered?: number;
}

async function queryEeBridge(raw: string, taskType?: string | null): Promise<BridgeResult> {
  try {
    // Enrich query with task context so EE embedding is more precise.
    // e.g. "analyze: vậy ở...fix?" vs generic "vậy ở...fix?" — the prefix
    // shifts the embedding toward task-relevant entries and away from generic
    // action-oriented behavioral patterns that score highly on any NL query.
    const queryWithTask = taskType ? `[${taskType}] ${raw}` : raw;

    // Parallel queries: T0 principles (lower floor, pre-validated abstractions)
    // and T1/T2 behavioral (standard floor, contextual patterns). Running both
    // concurrently keeps total latency at ~1500ms rather than ~3000ms.
    // Phase 3 (ee-anti-mu): third arm for compaction checkpoints so PIL can surface
    // prior "Progress ✔ DONE / elided" without the agent having to ask "task finished?".
    const signal = AbortSignal.timeout(PIL_SEARCH_TIMEOUT_MS);
    const planningQuery = isGsdNativeEnabled()
      ? `${PLANNING_CHECKPOINT_QUERY} OR compaction checkpoint`
      : 'Context checkpoint summary OR "compaction checkpoint" recent Progress DONE elided OR tool-artifact OR "tool result id="';
    const [principleRaw, behavioralRaw, checkpointRaw] = await Promise.all([
      searchByText(queryWithTask, ["experience-principles"], 3, signal),
      searchByText(queryWithTask, ["experience-behavioral"], 4, signal),
      searchByText(planningQuery, ["experience-behavioral"], 3, signal).catch(() => []),
    ]);

    const principlePoints = principleRaw.filter((p) => (p.score ?? 0) >= PIL_PRINCIPLES_FLOOR);
    const behavioralPoints = behavioralRaw.filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR);
    const checkpointPoints = (checkpointRaw as EEPoint[]).filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR * 0.7); // lowered for anti-mù: force surface 1-2 recent "Context checkpoint summary" ✔ DONE even on marginal scores for sessions with prior compacts (proxy via sessionId in caller)
    const filtered = principleRaw.length - principlePoints.length + (behavioralRaw.length - behavioralPoints.length);

    // T1 rules = proven-tier points from either collection. These get stored on
    // ctx and appended as MANDATORY RULES by Layer 6 — they're behavioral
    // reflexes, not hints.
    const t1Rules = [...principlePoints, ...behavioralPoints].filter(isT1Proven).map(extractPointText).filter(Boolean);

    return { principlePoints, behavioralPoints, t1Rules, checkpointPoints, filtered };
  } catch (err) {
    logEeFailure("pil.layer3.queryEeBridge", classifyEeError(err), err, { budgetMs: PIL_SEARCH_TIMEOUT_MS });
    return { principlePoints: [], behavioralPoints: [], t1Rules: [], checkpointPoints: [], error: String(err) };
  }
}

function formatPrincipleRules(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${extractPointText(p)} [id:${p.id}]`).filter((l) => l !== "- ");
  if (lines.length === 0) return "";
  return `[rules: Generalized principles from past work]\n${lines.join("\n")}`;
}

function formatExperienceHints(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points.map((p) => `- ${extractPointText(p)} [id:${p.id}]`).filter((l) => l !== "- ");
  if (lines.length === 0) return "";
  return `[experience: Relevant patterns from past work]\n${lines.join("\n")}`;
}

/**
 * Format compaction/task checkpoints surfaced by Layer 3 search.
 * These are the structured summaries persisted by orchestrator compactForContext (ee-anti-mu Phase 3).
 * Injected so the agent (and sub-agents) can answer "task đã xong chưa?", "đã compact được chưa?" from EE memory
 * without relying only on the ephemeral top-of-context summary that may be further compacted later.
 */
function formatTaskCheckpoints(points: EEPoint[]): string {
  if (points.length === 0) return "";
  const lines = points
    .map((p) => {
      const t = extractPointText(p);
      // Idea 4: surface tool-artifact refs so agent sees "elided high-value, query for full"
      if (/tool-artifact|tool result id=|elided.*id=/.test(t.toLowerCase())) {
        return `- [artifact] ${t.slice(0, 160)} [id:${p.id}]`;
      }
      return `- ${t.slice(0, 180)} [id:${p.id}]`;
    })
    .filter((l) => l !== "- ");
  if (lines.length === 0) return "";
  return `[task checkpoints — prior compactions: use to answer "task finished?", "compacted yet?". Artifacts: use ee.query tool with "tool-artifact id=XXX" for full elided tool output.] \n${lines.join("\n")}`;
}

export async function layer3EeInjection(ctx: PipelineContext): Promise<PipelineContext> {
  // Formatter mode: when L1 populated ctx._brainData via the unified call,
  // we just render — zero network round-trips.
  if (ctx._brainData) {
    const principlesBudget = Math.floor(ctx.tokenBudget * 0.15);
    const behavioralBudget = Math.floor(ctx.tokenBudget * 0.15);
    const parts: string[] = [];
    const deltas: string[] = [];

    // Collection fallback by array position mirrors the legacy path's arm→collection
    // mapping (t0 = principles, t2 = behavioral). The server (PIL schema_version
    // 1.1+) may override per-point — e.g. a selfqa hit merged into the behavioral
    // bucket carries collection="experience-selfqa" so ee_feedback resolves it.
    let principleItems = ctx._brainData.t0_principles.map((p) => ({
      ...p,
      collection: p.collection ?? "experience-principles",
    }));
    let behavioralItems = ctx._brainData.t2_patterns.map((p) => ({
      ...p,
      collection: p.collection ?? "experience-behavioral",
    }));
    // Suppress (a) already-fed-back entries AND (b) entries already surfaced
    // earlier this session (still pending) — re-injecting the full body of a
    // hint the agent already saw is pure repetition (the "hint lặp"); the hit
    // stays in the feedback nudge (shown once via _surfacedPendingIds) so the
    // rating path is preserved without duplicating content every turn.
    if (isRecallLedgerEnabled()) {
      const alreadyShown = (id: string) => sessionRecallLedger.wasCleared(id) || sessionRecallLedger.isPending(id);
      principleItems = principleItems.filter((p) => !alreadyShown(String(p.id)));
      behavioralItems = behavioralItems.filter((p) => !alreadyShown(String(p.id)));
    }
    // Render the [id:..] handle inline (mirrors formatPrincipleRules/Hints) so the
    // [id collection] reminder below refers to handles the agent can actually see.
    const renderLine = (p: { text: string; id?: string }): string =>
      p.id ? `- ${p.text.slice(0, 120)} [id:${p.id}]` : `- ${p.text.slice(0, 120)}`;

    if (principleItems.length > 0) {
      const lines = principleItems.map(renderLine);
      const block = truncateToBudget(
        `[principles: Generalized principles from past work]\n${lines.join("\n")}`,
        principlesBudget,
      );
      parts.push(block);
      deltas.push(`principles=${principleItems.length}`);
    }
    if (behavioralItems.length > 0) {
      const lines = behavioralItems.map(renderLine);
      const block = truncateToBudget(
        `[experience: Relevant patterns from past work]\n${lines.join("\n")}`,
        behavioralBudget,
      );
      parts.push(block);
      deltas.push(`behavioral=${behavioralItems.length}`);
    }
    deltas.push(`t1=${ctx._brainData.t1_rules.length}`);
    deltas.push(`src=unified`);

    // Close BOTH arms of the recall loop on the unified path, symmetric with the
    // legacy path below (previously this formatter rendered text only — invisible
    // to both arms). NEGATIVE arm: register surfaced ids for prompt-stale decay.
    // POSITIVE arm: record the rateable points (those carrying an id from
    // schema_version 1.1+) into the SAME session ledger the native ee_feedback
    // builtin clears, then surface a dynamic [id collection] reminder so an
    // explicit ee_feedback(followed) can credit the injection. No auto verdict is
    // emitted (that would pollute Gate-4 precision). Points without an id (older
    // server) fall through to the static nudge — rendered, but unrateable.
    const ledgerEnabled = isRecallLedgerEnabled();
    let ledgerRecorded = 0;
    const rateable = [...principleItems, ...behavioralItems].filter((p) => p.id);
    if (rateable.length > 0) {
      updateLastSurfacedState(rateable.map((p) => String(p.id)));
      if (ledgerEnabled) {
        sessionRecallLedger.record(
          rateable.map((p) => ({ id: String(p.id), collection: p.collection })),
          `passive-injection (unified): ${ctx.raw.slice(0, 80)}`,
        );
        ledgerRecorded = rateable.length;
      }
    }

    if (parts.length > 0 && principleItems.length + behavioralItems.length > 0) {
      const pending = ledgerEnabled ? sessionRecallLedger.pending() : [];
      if (pending.length > 0) {
        // Cross-turn dedup: only surface pending IDs NOT already shown in a prior
        // turn. Once the agent has seen the [id collection] handle, re-listing it
        // every turn is pure input noise.
        const sid = ctx.sessionId ?? "_anon";
        let surfaced = _surfacedPendingIds.get(sid);
        if (!surfaced) {
          surfaced = new Set<string>();
          _surfacedPendingIds.set(sid, surfaced);
        }
        const newPending = pending.filter((p) => !surfaced!.has(p.id));
        if (newPending.length > 0) {
          for (const p of newPending) surfaced!.add(p.id);
          parts.push(formatPendingReminder(newPending, { max: 5 }));
        }
        // else: all pending IDs were already surfaced — skip the nudge.
      } else {
        parts.push(RECALL_FEEDBACK_NUDGE);
      }
    }

    const injected = parts.join("\n");
    try {
      if (ctx.sessionId && parts.length > 0) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: "injected",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            source: "unified",
            principleCount: principleItems.length,
            behavioralCount: behavioralItems.length,
            t1RuleCount: ctx._brainData.t1_rules.length,
            pointIds: rateable.map((p) => String(p.id)),
            injectedChars: injected.length,
            // Recall-loop closure observability (harness verification reads these):
            // rateable points recorded as pending debt this turn + total unrated.
            ledgerRecorded,
            ledgerPending: sessionRecallLedger.pendingCount(),
            taskType: ctx.taskType ?? null,
            domain: ctx.domain ?? null,
          },
        });
      }
    } catch {
      /* fail-open — never break injection path */
    }

    return {
      ...ctx,
      enriched: parts.length > 0 ? `${ctx.enriched}\n${injected}` : ctx.enriched,
      t1Rules: ctx._brainData.t1_rules,
      layers: [
        ...ctx.layers,
        {
          name: "ee-experience-injection",
          applied: parts.length > 0,
          delta: deltas.join(" "),
        },
      ],
    };
  }

  // Legacy path: existing logic continues below — unchanged.
  const result = await queryEeBridge(ctx.raw, ctx.taskType);
  const { principlePoints, behavioralPoints, t1Rules } = result;
  const totalPoints = principlePoints.length + behavioralPoints.length;

  if (result.error) {
    try {
      if (ctx.sessionId) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: "error",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            error: result.error,
            queryLength: ctx.raw.length,
          },
        });
      }
    } catch {
      /* fail-open */
    }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: `error=${result.error}` }],
    };
  }

  if (totalPoints === 0) {
    try {
      if (ctx.sessionId) {
        logInteraction(ctx.sessionId, "ee_injection", {
          eventSubtype: result.filtered && result.filtered > 0 ? "filtered_noise" : "no_match",
          data: {
            phase: "pil_enrichment",
            role: "knowledge_retriever",
            queryLength: ctx.raw.length,
            filteredBelowFloor: result.filtered ?? 0,
            scoreFloor: PIL_SCORE_FLOOR,
            taskType: ctx.taskType ?? null,
          },
        });
      }
    } catch {
      /* fail-open */
    }
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "ee-experience-injection", applied: false, delta: "no-points" }],
    };
  }

  // BB dedup: skip any EE hit whose payload text sha16 is already marked in ctx.enriched.
  // This prevents double-injection when loop-driver CB-1 already injected BB context
  // via bb-retrieval.ts on the same pipeline run.
  const bbMarkerShas = extractBBMarkerShas(ctx.enriched);
  const deduplicatedPrinciples =
    bbMarkerShas.size > 0
      ? principlePoints.filter((p) => {
          const text = extractPointText(p);
          return text.length === 0 || !bbMarkerShas.has(payloadSha16(text));
        })
      : principlePoints;
  const deduplicatedBehavioral =
    bbMarkerShas.size > 0
      ? behavioralPoints.filter((p) => {
          const text = extractPointText(p);
          return text.length === 0 || !bbMarkerShas.has(payloadSha16(text));
        })
      : behavioralPoints;

  // Checkpoint dedup — now uses dedicated marker (full Phase 3 implementation).
  const checkpointMarkerShas = extractCheckpointMarkerShas(ctx.enriched);
  const deduplicatedCheckpoints =
    checkpointMarkerShas.size > 0
      ? (result.checkpointPoints || []).filter((p) => {
          const text = extractPointText(p);
          return text.length === 0 || !checkpointMarkerShas.has(payloadSha16(text));
        })
      : result.checkpointPoints || [];

  // Suppression: skip rateable hints that were already (a) rated via ee_feedback
  // OR (b) surfaced earlier this session (still pending). Re-injecting the full
  // body of a hint the agent already saw is the "hint lặp" repetition; the entry
  // stays in the feedback nudge (shown once) so rating is still prompted.
  // Checkpoints are GSD status context (not rateable) — only cleared-suppressed,
  // they may legitimately re-surface each turn.
  const ledgerEnabled = isRecallLedgerEnabled();
  const alreadyShown = (id: string) =>
    ledgerEnabled && (sessionRecallLedger.wasCleared(id) || sessionRecallLedger.isPending(id));
  const clearedFilteredPrinciples = deduplicatedPrinciples.filter((p) => !alreadyShown(String(p.id)));
  const clearedFilteredBehavioral = deduplicatedBehavioral.filter((p) => !alreadyShown(String(p.id)));
  const clearedFilteredCheckpoints = deduplicatedCheckpoints.filter(
    (p) => !(ledgerEnabled && sessionRecallLedger.wasCleared(String(p.id))),
  );
  const allPoints = [...clearedFilteredPrinciples, ...clearedFilteredBehavioral, ...clearedFilteredCheckpoints];

  // STALE-01: Register injected point IDs for prompt-stale reconciliation.
  updateLastSurfacedState(allPoints.map((p) => String(p.id)));

  // Close the POSITIVE arm of the recall loop in-process. Record the RATEABLE
  // injected points (principles + behavioral; checkpoints are artifacts, not
  // recall verdicts) into the SAME session ledger the native ee_feedback builtin
  // clears. Before this, the ledger was only ever populated by the external MCP
  // ee.query, so in-CLI ee_feedback.clear() was a guaranteed no-op and nothing
  // surfaced pending debt to the agent — leaving passive injections with an
  // automatic NEGATIVE signal (prompt-stale decay every turn) but no positive
  // one. Recording here makes a passive injection real, rateable debt that the
  // dynamic reminder below names and an explicit ee_feedback(followed) resolves —
  // the signal the brain needs to learn which injections were gold. No auto
  // verdict is emitted (that would pollute Gate-4 precision); the agent rates
  // deliberately. Collection is the search arm (deterministic), which is what
  // ee_feedback requires.
  let ledgerRecorded = 0;
  if (ledgerEnabled) {
    const rateableEntries = [
      ...deduplicatedPrinciples.map((p) => ({ id: String(p.id), collection: "experience-principles" })),
      ...deduplicatedBehavioral.map((p) => ({ id: String(p.id), collection: "experience-behavioral" })),
    ].filter((e) => e.id);
    if (rateableEntries.length > 0) {
      sessionRecallLedger.record(rateableEntries, `passive-injection: ${ctx.raw.slice(0, 80)}`);
      ledgerRecorded = rateableEntries.length;
    }
  }

  // CQ-16b: Emit experience_injected StreamChunk so TUI can show collapsible block.
  // Carry per-point {id, title, tier} so the TUI can show WHAT was injected, not
  // just how many (the data already exists here; previously only the count + ids
  // reached the client and the title was never serialized).
  const pointTitle = (p: EEPoint): string =>
    (extractPointText(p).split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const injectedPoints = [
    ...deduplicatedPrinciples.map((p) => ({ id: String(p.id), title: pointTitle(p), tier: "principle" as const })),
    ...deduplicatedBehavioral.map((p) => ({ id: String(p.id), title: pointTitle(p), tier: "behavioral" as const })),
    ...deduplicatedCheckpoints.map((p) => ({ id: String(p.id), title: pointTitle(p), tier: "checkpoint" as const })),
  ];
  try {
    const injectedChunk = {
      type: "experience_injected" as const,
      experienceInjected: {
        pointCount: totalPoints + deduplicatedCheckpoints.length,
        pointIds: allPoints.map((p) => String(p.id)),
        points: injectedPoints,
        scoreFloor: PIL_SCORE_FLOOR,
        taskType: ctx.taskType ?? undefined,
        domain: ctx.domain ?? undefined,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRenderSink()(injectedChunk as any);
  } catch {
    /* fail-open — never break injection path */
  }

  // T0 principles get 15% of budget (pre-validated, always-relevant abstractions).
  // T1/T2 behavioral get 15% of budget (contextual patterns).
  // Total EE injection stays within the original 30% budget share.
  const principlesBudget = Math.floor(ctx.tokenBudget * 0.15);
  const behavioralBudget = Math.floor(ctx.tokenBudget * 0.15);

  const parts: string[] = [];
  const rulesText = formatPrincipleRules(deduplicatedPrinciples);
  if (rulesText) parts.push(truncateToBudget(rulesText, principlesBudget));
  const hintsText = formatExperienceHints(deduplicatedBehavioral);
  if (hintsText) parts.push(truncateToBudget(hintsText, behavioralBudget));
  const cpText = formatTaskCheckpoints(deduplicatedCheckpoints);
  if (cpText) {
    const marker = `<!-- ee-checkpoint-injected:${payloadSha16(cpText)} -->`;
    // Idea 5: raised from 0.08 to 0.12 for higher fidelity on critical progress + artifact refs.
    parts.push(truncateToBudget(`${cpText}\n${marker}`, Math.floor(ctx.tokenBudget * 0.12)));
  }
  // Close the recall feedback loop at the injection site: passively-injected
  // experience (the agent did not ee_query for it) otherwise carries no feedback
  // prompt, so it goes unrated and EE cannot learn if the injection was gold or
  // noise. The front-loaded native-capabilities instruction can be compacted away
  // on long sessions; this nudge rides next to the [id:..] handles it refers to.
  // Gated on rateable experience (principles/behavioral) — checkpoints are task
  // artifacts, not recall verdicts.
  // Dynamic, token-bounded reminder of accumulated unrated debt (this turn's
  // fresh injections + any earlier still-unrated ones), naming the actual
  // [id collection] so ee_feedback is actionable — the static nudge named no ids,
  // so the model could not complete a rating even when willing. Falls back to the
  // static nudge when the ledger is disabled. Gated on rateable experience.
  // Cross-turn dedup: only surface pending IDs NOT already shown in a prior
  // turn. Once surfaced, the agent has seen the [id collection] handle and can
  // act on it (ee_feedback) or ignore it — re-listing the same IDs every turn
  // is pure input noise with no new signal. If nothing is new, skip the nudge.
  if (deduplicatedPrinciples.length + deduplicatedBehavioral.length > 0) {
    const pending = ledgerEnabled ? sessionRecallLedger.pending() : [];
    if (pending.length > 0) {
      const sid = ctx.sessionId ?? "_anon";
      let surfaced = _surfacedPendingIds.get(sid);
      if (!surfaced) {
        surfaced = new Set<string>();
        _surfacedPendingIds.set(sid, surfaced);
      }
      const newPending = pending.filter((p) => !surfaced!.has(p.id));
      if (newPending.length > 0) {
        for (const p of newPending) surfaced!.add(p.id);
        parts.push(formatPendingReminder(newPending, { max: 5 }));
      }
      // else: all pending IDs were already surfaced — skip the nudge entirely.
    } else {
      // No pending debt at all; fall back to the generic static nudge.
      parts.push(RECALL_FEEDBACK_NUDGE);
    }
  }
  const injected = parts.join("\n");

  try {
    if (ctx.sessionId) {
      logInteraction(ctx.sessionId, "ee_injection", {
        eventSubtype: "injected",
        data: {
          phase: "pil_enrichment",
          role: "knowledge_retriever",
          principleCount: principlePoints.length,
          behavioralCount: behavioralPoints.length,
          checkpointCount: deduplicatedCheckpoints.length,
          t1RuleCount: t1Rules.length,
          pointIds: allPoints.map((p) => String(p.id)),
          injectedChars: injected.length,
          // Recall-loop closure observability (harness verification reads these
          // from the interaction log): how many rateable points were recorded as
          // pending debt this turn, and the total still-unrated debt afterwards.
          ledgerRecorded,
          ledgerPending: sessionRecallLedger.pendingCount(),
          taskType: ctx.taskType ?? null,
          domain: ctx.domain ?? null,
        },
      });
    }
  } catch {
    /* fail-open */
  }

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${injected}`,
    t1Rules: t1Rules.length > 0 ? t1Rules : ctx.t1Rules,
    layers: [
      ...ctx.layers,
      {
        name: "ee-experience-injection",
        applied: true,
        delta: `principles=${deduplicatedPrinciples.length} behavioral=${deduplicatedBehavioral.length} checkpoints=${deduplicatedCheckpoints.length} t1=${t1Rules.length} chars=${injected.length}${bbMarkerShas.size > 0 ? ` bb-dedup=${bbMarkerShas.size}` : ""}`,
      },
    ],
  };
}

/**
 * Records whose text actually reads like a compaction checkpoint or an elided
 * tool-artifact. Used to keep generic behavioral hits from being mislabelled as
 * `[artifact]`/checkpoint lines when we search by the meta question (ctx.raw)
 * rather than the fixed checkpoint-arm query.
 */
const CHECKPOINT_LIKE_RE =
  /context checkpoint summary|compaction checkpoint|tool-artifact|tool result id=|elided|progress[^a-z]*done|✔/i;

/**
 * Issue #4 — meta-turn TARGETED complement to Layer 3's checkpoint arm.
 *
 * Since issue #2, Layer 3 now runs on the meta-analysis path too, so its
 * checkpoint arm already surfaces recent checkpoints/artifacts for the agent.
 * That arm uses a FIXED recency query, though — it isn't biased toward the
 * current meta question. This arm fills that gap: it searches by `ctx.raw` so a
 * self-evaluating agent sees the elided tool-artifacts RELEVANT to what it's
 * analyzing, rendered via the same `formatTaskCheckpoints` so the `[artifact]
 * … id=X` refs appear automatically instead of waiting on a manual `ee_query`.
 *
 * Defers to Layer 3: if a checkpoint block was already injected this turn (any
 * `ee-checkpoint-injected` marker present) it skips entirely — no duplicate
 * block and no second EE round-trip. Gated on `sessionId` (no session ⇒ no prior
 * compaction to rehydrate). Strictly additive and fail-open: any error /
 * no-session / no-match / already-surfaced returns ctx with the original
 * `enriched` plus an `ee-meta-artifacts` layer marker for forensics.
 */
export async function surfaceCompactionArtifacts(ctx: PipelineContext): Promise<PipelineContext> {
  const markLayer = (applied: boolean, delta: string): PipelineContext => ({
    ...ctx,
    layers: [...ctx.layers, { name: "ee-meta-artifacts", applied, delta }],
  });

  if (!ctx.sessionId) return markLayer(false, "no-session");
  // Defer to Layer 3: a checkpoint/artifact block is already present this turn,
  // so don't duplicate it or pay a second EE round-trip. This arm only fills the
  // gap when Layer 3's fixed-query checkpoint arm surfaced nothing.
  if (extractCheckpointMarkerShas(ctx.enriched).size > 0) return markLayer(false, "already-surfaced");

  let points: EEPoint[] = [];
  try {
    const signal = AbortSignal.timeout(PIL_SEARCH_TIMEOUT_MS);
    // Bias toward records relevant to THIS meta question (ctx.raw) while pulling
    // in checkpoint/artifact vocabulary so the single cheap arm lands on the
    // compaction records rather than generic behavioral patterns.
    const query = `${ctx.raw}\nContext checkpoint summary tool-artifact "tool result id=" elided Progress DONE`;
    const raw = await searchByText(query, ["experience-behavioral"], 5, signal);
    points = (raw as EEPoint[])
      .filter((p) => (p.score ?? 0) >= PIL_SCORE_FLOOR * 0.7)
      .filter((p) => CHECKPOINT_LIKE_RE.test(extractPointText(p)));
  } catch (err) {
    logEeFailure("pil.meta.surfaceCompactionArtifacts", classifyEeError(err), err, { budgetMs: PIL_SEARCH_TIMEOUT_MS });
    return markLayer(false, `error=${String(err)}`);
  }

  if (points.length === 0) return markLayer(false, "no-artifacts");

  const cpText = formatTaskCheckpoints(points);
  if (!cpText) return markLayer(false, "no-artifacts");

  // Append the marker AFTER truncation so it always survives into `enriched`
  // — that marker is what makes the defer-check above fire on any later pass.
  const blockSha = payloadSha16(cpText);
  const body = truncateToBudget(cpText, Math.floor(ctx.tokenBudget * 0.12));
  const block = `${body}\n<!-- ee-checkpoint-injected:${blockSha} -->`;

  try {
    if (ctx.sessionId) {
      logInteraction(ctx.sessionId, "ee_injection", {
        eventSubtype: "injected",
        data: {
          phase: "pil_meta_artifacts",
          role: "knowledge_retriever",
          checkpointCount: points.length,
          pointIds: points.map((p) => String(p.id)),
          injectedChars: block.length,
        },
      });
    }
  } catch (err) {
    // No silent catch: surfacing succeeded; only the audit write failed.
    console.error(`[pil.meta.surfaceCompactionArtifacts] interaction log failed: ${(err as Error)?.message}`);
  }

  return {
    ...ctx,
    enriched: `${ctx.enriched}\n${block}`,
    layers: [
      ...ctx.layers,
      { name: "ee-meta-artifacts", applied: true, delta: `artifacts=${points.length} chars=${block.length}` },
    ],
  };
}
