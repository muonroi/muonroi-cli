/**
 * src/reporter/handlers.ts
 *
 * Handler functions for each QueryKind. Each returns the reply text to post
 * to Discord. No Discord calls here — just string production.
 */

import { pickCouncilTaskModel } from "../council/leader.js";
import type { CouncilLLM } from "../council/types.js";
import { readBacklog } from "../product-loop/backlog-store.js";
import { computeProgressSnapshot, renderSnapshotMarkdown } from "../product-loop/progress-snapshot.js";
import { readSprintPlan } from "../product-loop/sprint-store.js";
import type { Sprint } from "../product-loop/types.js";
import { getReporterDailySpend, recordReporterSpend } from "./budget.js";

export interface ReporterDeps {
  flowDir: string;
  runId: string;
  productSlug: string;
  llm: CouncilLLM;
  leaderModelId: string;
  dailyBudget: number;
}

// ─── Progress ────────────────────────────────────────────────────────────────

/**
 * Serve a standard progress query — renders the ProgressSnapshot as markdown.
 */
export async function handleProgressQuery(deps: ReporterDeps): Promise<string> {
  try {
    const snapshot = await computeProgressSnapshot({
      flowDir: deps.flowDir,
      runId: deps.runId,
      productSlug: deps.productSlug,
    });
    return renderSnapshotMarkdown(snapshot);
  } catch (err) {
    return `Unable to compute progress snapshot: ${(err as Error).message}`;
  }
}

// ─── Sprint ───────────────────────────────────────────────────────────────────

function renderSprintMarkdown(
  sprint: Sprint,
  backlogItems: Array<{ id: string; title: string; status: string }>,
): string {
  const lines: string[] = [];
  lines.push(`## Sprint ${sprint.number} — ${sprint.goal}`);
  lines.push(`Status: **${sprint.status}**`);
  if (sprint.startedAtUtc) lines.push(`Started: ${sprint.startedAtUtc}`);
  if (sprint.endedAtUtc) lines.push(`Ended: ${sprint.endedAtUtc}`);
  lines.push("");
  if (backlogItems.length === 0) {
    lines.push("_No items linked to this sprint._");
  } else {
    lines.push("**Items:**");
    for (const item of backlogItems) {
      const icon = item.status === "done" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
      lines.push(`- ${icon} ${item.title} (${item.status})`);
    }
  }
  return lines.join("\n");
}

/**
 * Serve a sprint-specific query — shows sprint goal + items.
 */
export async function handleSprintQuery(deps: ReporterDeps, sprintNumber: number): Promise<string> {
  try {
    const sprintPlan = await readSprintPlan(deps.flowDir, deps.runId);
    if (!sprintPlan) {
      return `No sprint plan found for run ${deps.runId}.`;
    }

    const sprint = sprintPlan.sprints.find((s) => s.number === sprintNumber);
    if (!sprint) {
      return `Sprint ${sprintNumber} not found. Available sprints: ${sprintPlan.sprints.map((s) => s.number).join(", ")}.`;
    }

    const backlog = await readBacklog(deps.flowDir, deps.runId);
    const backlogItems = sprint.itemIds
      .map((id) => backlog?.items.find((i) => i.id === id))
      .filter((i): i is NonNullable<typeof i> => i !== undefined)
      .map((i) => ({ id: i.id, title: i.title, status: i.status as string }));

    return renderSprintMarkdown(sprint, backlogItems);
  } catch (err) {
    return `Unable to fetch sprint ${sprintNumber}: ${(err as Error).message}`;
  }
}

// ─── Item ─────────────────────────────────────────────────────────────────────

/**
 * Serve an item query — fuzzy substring match on backlog item titles.
 */
export async function handleItemQuery(deps: ReporterDeps, query: string): Promise<string> {
  try {
    const backlog = await readBacklog(deps.flowDir, deps.runId);
    if (!backlog || backlog.items.length === 0) {
      return "No backlog found for this run.";
    }

    const lcQuery = query.toLowerCase();
    const matches = backlog.items.filter((i) => i.title.toLowerCase().includes(lcQuery));

    if (matches.length === 0) {
      return `No backlog items matched "${query}".`;
    }

    if (matches.length > 3) {
      const titles = matches
        .slice(0, 3)
        .map((i) => `- ${i.title}`)
        .join("\n");
      return `Multiple items matched "${query}" — showing top 3:\n${titles}\n\nRefine your query to get details.`;
    }

    if (matches.length > 1) {
      const titles = matches.map((i) => `- ${i.title}`).join("\n");
      return `Multiple items matched "${query}":\n${titles}\n\nRefine your query to get details.`;
    }

    const item = matches[0]!;
    const lines: string[] = [];
    lines.push(`## ${item.title}`);
    lines.push(`**Status:** ${item.status}`);
    lines.push(`**Priority:** ${item.mvp_priority}`);
    lines.push(`**Effort:** ${item.effortPoints}pts`);
    lines.push("");
    lines.push(item.description);
    lines.push("");
    lines.push("**Acceptance criteria:**");
    for (const ac of item.acceptance_criteria) {
      lines.push(`- ${ac}`);
    }
    if (item.deferral_reason) {
      lines.push("");
      lines.push(`**Deferral reason:** ${item.deferral_reason}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `Unable to fetch backlog item: ${(err as Error).message}`;
  }
}

// ─── Free-form (LLM) ──────────────────────────────────────────────────────────

/**
 * Serve a free-form question via LLM, subject to daily budget gate.
 * Falls back to template snapshot reply when budget is exhausted.
 */
export async function handleFreeformQuery(deps: ReporterDeps, text: string): Promise<string> {
  const spent = await getReporterDailySpend(deps.flowDir, deps.runId);
  if (spent >= deps.dailyBudget) {
    // Budget exhausted — fall back to snapshot template with note
    const snapshotText = await handleProgressQuery(deps);
    return (
      `⚠️ LLM budget exhausted for today ($${spent.toFixed(2)} of $${deps.dailyBudget.toFixed(2)}). Resumes UTC midnight.\n\n` +
      snapshotText
    );
  }

  // Gather context for the LLM
  const [backlog, sprintPlan, snapshot] = await Promise.all([
    readBacklog(deps.flowDir, deps.runId).catch(() => null),
    readSprintPlan(deps.flowDir, deps.runId).catch(() => null),
    computeProgressSnapshot({
      flowDir: deps.flowDir,
      runId: deps.runId,
      productSlug: deps.productSlug,
    }).catch(() => null),
  ]);

  const system = [
    "You are a project status assistant. Answer the user's question USING ONLY the snapshot data below.",
    "If the snapshot doesn't contain the answer, say so — do NOT invent details.",
    "Be concise. Reply in the same language as the user's question.",
    "",
    "## Current Progress Snapshot",
    snapshot ? JSON.stringify(snapshot, null, 2) : "(not available)",
    "",
    "## Backlog Items (full detail)",
    backlog ? JSON.stringify(backlog.items, null, 2) : "(not available)",
    "",
    "## Sprint Plan",
    sprintPlan ? JSON.stringify(sprintPlan, null, 2) : "(not available)",
  ].join("\n");

  const modelId = pickCouncilTaskModel("reporter_qa", deps.leaderModelId, true);

  let costUsd = 0;
  let reply: string;
  try {
    reply = await deps.llm.generate(modelId, system, text, 1024, (usage) => {
      // Conservative cost estimate: $1 per 1M tokens.
      // Real cost tracking left to the provider billing; this keeps budget.json approximate.
      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      costUsd = tokens * 0.000001;
    });
  } catch (err) {
    return `LLM call failed: ${(err as Error).message}\n\n${snapshot ? renderSnapshotMarkdown(snapshot) : ""}`;
  }

  if (costUsd > 0) {
    await recordReporterSpend(deps.flowDir, deps.runId, costUsd).catch(() => {});
  }

  return reply;
}
