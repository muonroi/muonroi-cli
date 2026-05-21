/**
 * src/reporter/index.ts
 *
 * P8 Reporter Agent — main loop.
 *
 * Runs as a separate long-lived process: muonroi reporter --run <runId>
 * Polls the product's Discord channel for messages, classifies them,
 * dispatches to handlers, and posts replies.
 *
 * Manual smoke test:
 *   1. Start a worker: muonroi ideal "build X" in terminal A.
 *   2. In terminal B: muonroi reporter --run <runId> --product-slug <slug>
 *   3. In the product's Discord channel, type "progress?"
 *   4. Reporter should reply within 5s with a ProgressSnapshot markdown card.
 *
 * Worker process is UNTOUCHED — reporter is read-only on all worker artifacts
 * (backlog.json, sprint-plan.json, interaction_logs). Only writes:
 *   - Discord messages
 *   - reporter-budget.json (LLM spend tracking)
 *   - interaction_logs (heartbeat rows with event_type="reporter")
 */

import type { ChatClient } from "../chat/types.js";
import type { CouncilLLM } from "../council/types.js";
import { getDatabase } from "../storage/db.js";
import { buildUnauthorizedReply, checkStakeholder } from "./acl-check.js";
import {
  handleFreeformQuery,
  handleItemQuery,
  handleProgressQuery,
  handleSprintQuery,
  type ReporterDeps,
} from "./handlers.js";
import { classifyQuery } from "./query-router.js";

// ─── Config / Deps types ──────────────────────────────────────────────────────

export interface ReporterRuntimeConfig {
  runId: string;
  flowDir: string;
  productSlug: string;
  channelId: string;
  pollIntervalMs?: number;
  dailyLlmBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface ReporterDepsExt {
  chat: ChatClient;
  llm: CouncilLLM;
  leaderModelId: string;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const HEARTBEAT_EVERY_N_POLLS = 12; // ~60s at default 5s poll interval

function emitHeartbeat(runId: string): void {
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO interaction_logs (session_id, event_type, event_subtype, metadata_json, created_at)
       VALUES (?, 'reporter', 'heartbeat', '{}', ?)`,
    ).run(runId, new Date().toISOString());
  } catch {
    // Best-effort — never crash the reporter over a heartbeat write failure.
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

/**
 * Run the reporter loop until signal fires or an unrecoverable error occurs.
 *
 * Separating deps (injectable, testable) from config (runtime scalars) allows
 * unit tests to inject mock chat + llm without touching the CLI layer.
 */
export async function runReporter(deps: ReporterDepsExt, config: ReporterRuntimeConfig): Promise<void> {
  const { chat, llm, leaderModelId } = deps;
  const { runId, flowDir, productSlug, channelId } = config;
  const pollIntervalMs = config.pollIntervalMs ?? 5_000;
  const dailyBudget = config.dailyLlmBudgetUsd ?? 0.5;
  const signal = config.signal;

  const handlerDeps: ReporterDeps = {
    flowDir,
    runId,
    productSlug,
    llm,
    leaderModelId,
    dailyBudget,
  };

  // Prime the cursor — skip messages that existed before reporter started.
  let lastSeenId: string | undefined;
  try {
    const seed = await chat.getChannelMessages(channelId, { limit: 1 });
    lastSeenId = seed.length > 0 ? seed[0]!.id : undefined;
  } catch {
    lastSeenId = undefined;
  }

  let botId: string;
  try {
    botId = await chat.getCurrentUserId();
  } catch (err) {
    throw new Error(`Reporter: failed to get bot user id — ${(err as Error).message}`);
  }

  let pollCount = 0;

  while (true) {
    if (signal?.aborted) break;

    // Heartbeat
    pollCount++;
    if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
      emitHeartbeat(runId);
    }

    // Fetch new messages
    let messages;
    try {
      messages = await chat.getChannelMessages(channelId, {
        afterId: lastSeenId,
        limit: 50,
      });
    } catch (err) {
      console.error(`[reporter] Discord poll error: ${(err as Error).message}`);
      await sleep(pollIntervalMs, signal);
      continue;
    }

    // Process messages in chronological order (Discord returns newest-first).
    const ordered = [...messages].reverse();

    for (const msg of ordered) {
      if (signal?.aborted) break;

      // Skip bot's own messages to avoid reply loops.
      if (msg.author.id === botId) continue;

      // Update cursor before handling (so a crash doesn't re-process).
      lastSeenId = msg.id;

      // ACL check
      let aclResult;
      try {
        aclResult = await checkStakeholder(productSlug, msg.author.id);
      } catch {
        aclResult = { authorized: false as const, stakeholderUsernames: [] as string[] };
      }

      if (!aclResult.authorized) {
        const reply = buildUnauthorizedReply(aclResult);
        await chat.postMessage(channelId, reply).catch((e: Error) => {
          console.error(`[reporter] postMessage (acl deny) failed: ${e.message}`);
        });
        continue;
      }

      // Classify + dispatch
      const classified = classifyQuery(msg.content);
      let reply: string;

      try {
        switch (classified.kind) {
          case "progress":
            reply = await handleProgressQuery(handlerDeps);
            break;
          case "sprint":
            reply = await handleSprintQuery(handlerDeps, classified.sprintNumber ?? 1);
            break;
          case "item":
            reply = await handleItemQuery(handlerDeps, classified.itemQuery ?? "");
            break;
          default:
            reply = await handleFreeformQuery(handlerDeps, msg.content);
            break;
        }
      } catch (err) {
        reply = `Reporter encountered an error: ${(err as Error).message}`;
      }

      await chat.postMessage(channelId, reply).catch((e: Error) => {
        console.error(`[reporter] postMessage failed: ${e.message}`);
      });
    }

    // Update cursor to the last message in the batch even if we skipped bot msgs.
    if (ordered.length > 0) {
      lastSeenId = ordered[ordered.length - 1]!.id;
    }

    if (signal?.aborted) break;
    await sleep(pollIntervalMs, signal);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
