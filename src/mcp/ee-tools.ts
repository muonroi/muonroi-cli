/**
 * src/mcp/ee-tools.ts
 *
 * EE (Experience Engine) MCP tools: ee_query (semantic recall) + ee_health +
 * ee_feedback (rate a recalled entry). Read-mostly; ee_feedback POSTs a verdict.
 *
 * Anti-mù: ee_query supports explicit "recent task checkpoint" / "Progress DONE" queries
 * so the agent (or sub-agent) can deliberately confirm finished subtasks after compactions.
 * collections: prefer "experience-behavioral" for compaction checkpoints (see layer3).
 *
 * Feedback gate: ee_query stamps every returned `[id col]` into a session-scoped
 * pending ledger (recall-ledger.ts). Subsequent ee_query calls surface (soft) or
 * refuse on (hard) accumulated unrated debt, so useful recalls actually get a
 * verdict via ee_feedback — the signal the brain needs to keep the good entries
 * and prune the rest. Mode via EXPERIENCE_RECALL_FEEDBACK_GATE = off|soft|hard
 * (default soft); hard-mode threshold via EXPERIENCE_RECALL_FEEDBACK_THRESHOLD.
 *
 * Dependencies are injected (deps) so unit tests never touch the network/singleton.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PendingRecall, type RecallLedger, sessionRecallLedger } from "../ee/recall-ledger.js";
import {
  type FeedbackResult,
  type FeedbackVerdict,
  formatRecallForAgent,
  healthEE,
  type NoiseReason,
  recallEE,
} from "../ee/search.js";
import type { EERecallResponse } from "../ee/types.js";

export interface EEToolDeps {
  recall?: (query: string, opts: { project?: string }) => Promise<EERecallResponse | null>;
  health?: () => Promise<{ ok: boolean; status: number }>;
  feedback?: (
    pointId: string,
    collection: string,
    verdict: FeedbackVerdict,
    reason?: NoiseReason,
  ) => Promise<FeedbackResult>;
  /** Session pending-recall ledger. Defaults to the process singleton. */
  ledger?: RecallLedger;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(error: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error, message }) }],
    isError: true,
  };
}

type GateMode = "off" | "soft" | "hard";

/** Resolve the feedback-gate policy from env at call time (so tests can vary it). */
function resolveGate(): { mode: GateMode; threshold: number } {
  const raw = String(process.env.EXPERIENCE_RECALL_FEEDBACK_GATE ?? "soft")
    .trim()
    .toLowerCase();
  const mode: GateMode = raw === "off" || raw === "hard" ? raw : "soft";
  const parsed = Number.parseInt(process.env.EXPERIENCE_RECALL_FEEDBACK_THRESHOLD ?? "", 10);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  return { mode, threshold };
}

/** One readable block naming the still-unrated recalls + how to clear them. */
function formatPendingBlock(pending: PendingRecall[], hard: boolean, max = 8): string {
  const shown = pending.slice(0, max);
  const lines = shown.map((p) => `  - [${p.id} ${p.collection ?? "?"}]  (from recall: "${p.query}")`);
  const more = pending.length > max ? `\n  …and ${pending.length - max} more` : "";
  const head = hard
    ? `⚠️ FEEDBACK GATE — ${pending.length} earlier recall(s) are still unrated. Rate them with ` +
      `ee_feedback(id, collection, verdict) before pulling new recalls:`
    : `⚠️ ${pending.length} earlier recall(s) still unrated — call ` +
      `ee_feedback(id, collection, verdict=followed|ignored|noise) so the brain keeps what helped and prunes the rest:`;
  return `${head}\n${lines.join("\n")}${more}`;
}

export function registerEETools(server: McpServer, deps: EEToolDeps = {}): void {
  // Default to the shared EE recall/health/feedback helpers (src/ee/search.ts) so
  // the MCP tools and the in-CLI builtin tools resolve auth/baseUrl the same way.
  // Tests inject `deps` to avoid the network and a fresh `ledger` to stay isolated.
  const recall = deps.recall ?? ((q, o) => recallEE(q, o));
  const health = deps.health ?? (() => healthEE());
  const ledger = deps.ledger ?? sessionRecallLedger;

  server.registerTool(
    "ee_query",
    {
      description:
        "Active recall over the Experience Engine brain — prior decisions, gotchas, learned warnings/recipes, and " +
        "task checkpoints for this codebase — via the recallMode pipeline (same path as exp-recall.js). " +
        "CALL THIS PROACTIVELY, before acting: when starting work in an unfamiliar area, when unsure how something " +
        "is done in this stack, before a risky or hard-to-reverse step, or to recall finished work after a " +
        "compaction (e.g. query='recent compaction checkpoint Progress DONE for <subtask>'). A deliberate query " +
        "here is cheaper than re-deriving or repeating a past mistake. Returns a formatted index whose entries " +
        "carry `[id col]` handles — after you act on a recall, rate each entry you used or judged with the " +
        "ee_feedback tool (followed/ignored/noise) so the brain keeps what helped and prunes the rest; unrated " +
        "recalls are surfaced back to you on the next ee_query. Optional project scopes the recall. Returns a " +
        "compact ranked index (cosine-ranked, strongest first), capped at maxChars (default 6000, range " +
        "500-20000) and truncated from the tail; raise maxChars to see more. Returns ee_unavailable if EE is " +
        "down (then proceed without it).",
      inputSchema: {
        query: z.string().min(1).max(1000),
        project: z.string().max(200).optional(),
        maxChars: z.number().int().min(500).max(20_000).optional(),
      },
    },
    async ({ query, project, maxChars }) => {
      const gate = resolveGate();
      const pendingBefore = gate.mode === "off" ? [] : ledger.pending();
      // Hard gate: refuse a NEW recall while unrated debt is at/over threshold —
      // do not even spend the brain call. Below threshold, fall through to soft.
      if (gate.mode === "hard" && pendingBefore.length >= gate.threshold) {
        return fail("feedback_required", formatPendingBlock(pendingBefore, true));
      }
      try {
        const resp = await recall(query, { project });
        if (resp === null) {
          return fail("ee_unavailable", "EE recall returned no response (server down, timeout, or circuit open)");
        }
        // Stamp the new entries as pending debt (unless the gate is off).
        if (gate.mode !== "off") ledger.record(resp.entries, query);
        // Return the compact `[id col]` index (capped) rather than JSON.stringify
        // of the whole response — the wide-net recall text (~30k) otherwise blows
        // the MCP per-result token cap and spills to a file. See formatRecallForAgent.
        const index = formatRecallForAgent(resp, { query, maxChars });
        if (gate.mode !== "off" && pendingBefore.length > 0) {
          return okText(`${formatPendingBlock(pendingBefore, false)}\n\n${index}`);
        }
        return okText(index);
      } catch (e) {
        return fail("ee_unavailable", e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "ee_feedback",
    {
      description:
        "Rate an Experience Engine recall entry so the brain keeps what helped and prunes the rest. Call after " +
        "acting on an ee_query result — once per `[id col]` you used or judged. verdict: 'followed' (you changed " +
        "your approach because of it), 'ignored' (topical but did not apply this time), 'noise' (wrong by category — " +
        "REQUIRES reason: wrong_repo | wrong_language | wrong_task | stale_rule). id may be a short prefix; the " +
        "server resolves it. Clears the entry from this session's pending-feedback gate.",
      inputSchema: {
        id: z.string().min(1).max(200),
        collection: z.string().min(1).max(200),
        verdict: z.enum(["followed", "ignored", "noise"]),
        reason: z.enum(["wrong_repo", "wrong_language", "wrong_task", "stale_rule"]).optional(),
      },
    },
    async ({ id, collection, verdict, reason }) => {
      if (verdict === "noise" && !reason) {
        return fail(
          "reason_required",
          "verdict 'noise' requires reason: wrong_repo | wrong_language | wrong_task | stale_rule",
        );
      }
      const feedback =
        deps.feedback ?? ((pid, col, v, r) => import("../ee/search.js").then((m) => m.feedbackEE(pid, col, v, r)));
      try {
        const result = await feedback(id, collection, verdict, reason);
        if (!result.ok) {
          return fail("feedback_failed", result.error ?? "feedback POST failed");
        }
        // Clear by the server-resolved full id AND the (possibly short) id the
        // agent passed, so a prefix-based call still settles the ledger debt.
        const clearedId = result.resolvedId ?? id;
        ledger.clear(clearedId);
        ledger.clear(id);
        return ok({
          ok: true,
          id: clearedId,
          verdict: result.verdict,
          ...(result.reason ? { reason: result.reason } : {}),
          pendingRemaining: ledger.pendingCount(),
        });
      } catch (e) {
        return fail("feedback_failed", e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "ee_health",
    { description: "Check Experience Engine server reachability.", inputSchema: {} },
    async () => {
      try {
        return ok(await health());
      } catch (e) {
        return fail("ee_unavailable", e instanceof Error ? e.message : String(e));
      }
    },
  );
}
