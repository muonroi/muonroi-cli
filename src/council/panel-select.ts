/**
 * src/council/panel-select.ts
 *
 * U3 — task-aware debate panel selection. Instead of a fixed capability roster
 * (resolveParticipants picks by tier, blind to the prompt), the leader reads the
 * task and CHOOSES which reachable models should debate it. Fail-open: any parse
 * / provider failure returns null and the caller keeps the default roster. The
 * internal implement/verify/research routing slots are assigned here purely for
 * downstream compatibility — they are never surfaced to the user (the UI shows
 * the task-adaptive persona / model, per U1.1).
 */

import type { StreamChunk } from "../types/index.js";
import type { ModelRole } from "../utils/settings.js";
import type { CouncilCandidate } from "./leader.js";
import { tracedGenerate } from "./llm.js";
import type { CouncilLLM } from "./types.js";

const ALL_ROLES: ModelRole[] = ["implement", "verify", "research"];

const SELECT_SYSTEM =
  "You are the council leader assembling a debate panel for a specific task. From the AVAILABLE MODELS, " +
  "pick the 2-4 that will produce the most rigorous, diverse debate for THIS task — prefer provider and " +
  "tier diversity, and match model strengths to what the task actually needs (e.g. a decision/analysis task " +
  "wants strong reasoners; a build task wants a coding-capable model plus a critical reviewer). " +
  'Return ONLY JSON: {"members":[{"model":"<exact id from the list>","why":"<short reason>"}]}. ' +
  "Use exact model ids from the list; never invent an id.";

/**
 * Ask the leader to select a task-appropriate debate panel from `pool`.
 * Returns a roster (models mapped onto internal routing roles) or null when the
 * leader is unavailable / returns an unusable selection — the caller then keeps
 * its default roster.
 */
export async function* selectTaskAwarePanel(opts: {
  topic: string;
  pool: CouncilCandidate[];
  leaderModelId: string;
  llm: CouncilLLM;
}): AsyncGenerator<StreamChunk, Array<{ role: ModelRole; model: string }> | null, unknown> {
  const { topic, pool, leaderModelId, llm } = opts;
  if (pool.length < 2) return null;

  const poolList = pool
    .map(
      (c) =>
        `- ${c.model}${c.tier ? ` [${c.tier}]` : ""}${c.provider ? ` (${c.provider})` : ""}: ${c.description.slice(0, 120)}`,
    )
    .join("\n");
  const prompt = `## Task\n${topic}\n\n## Available models\n${poolList}\n\nSelect the 2-4 models best suited to debate this task.`;

  let raw: string;
  try {
    raw = yield* tracedGenerate(llm, {
      phase: "panel_select",
      label: "Leader selecting debate panel",
      modelId: leaderModelId,
      system: SELECT_SYSTEM,
      prompt,
      maxTokens: 512,
    });
  } catch (err) {
    // Fail-open: caller keeps its default roster. Log so a provider outage on
    // the leader model is diagnosable instead of silently degrading panel
    // selection to the prompt-blind roster. (No-Silent-Catch.)
    console.error(
      `[council/panel-select] leader panel selection call failed, keeping default roster: ${err instanceof Error ? err.message : String(err)}`,
      { leaderModelId, poolSize: pool.length },
    );
    return null;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("[council/panel-select] leader returned no JSON object, keeping default roster", {
      leaderModelId,
      rawHead: raw.slice(0, 200),
    });
    return null;
  }
  let parsed: { members?: Array<{ model?: unknown }> };
  try {
    parsed = JSON.parse(match[0]) as { members?: Array<{ model?: unknown }> };
  } catch (err) {
    console.error(
      `[council/panel-select] leader selection JSON parse failed, keeping default roster: ${err instanceof Error ? err.message : String(err)}`,
      { leaderModelId, rawHead: match[0].slice(0, 200) },
    );
    return null;
  }

  const valid = new Set(pool.map((c) => c.model));
  const picked: string[] = [];
  for (const m of parsed.members ?? []) {
    const id = typeof m?.model === "string" ? m.model.trim() : "";
    if (id && valid.has(id) && !picked.includes(id)) picked.push(id);
    if (picked.length >= 4) break;
  }
  if (picked.length < 2) return null;

  // Roles are internal cost-tier routing slots (hidden from UI); assign cyclically.
  return picked.map((model, i) => ({ role: ALL_ROLES[i % ALL_ROLES.length], model }));
}
