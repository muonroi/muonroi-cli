import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { LeaderLike } from "../product-loop/discovery-prompt-parser.js";
import { publish } from "./broadcast-bus.js";
import { buildConvoPrompt, type ConvoTurn, parseConvoReply, SYSTEM_PROMPT } from "./intent-prompt.js";
import type { DiscordClient, PollCursor } from "./types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_LEADER_FAILURES_BEFORE_FALLBACK,
  MAX_MESSAGES_PER_POLL,
  MAX_UNKNOWN_INTENT_BEFORE_FALLBACK,
  maxVerdictMessages,
  verdictFloor,
} from "./verdict-constants.js";

export interface DiscordAwaitVerdictArgs {
  flowDir: string;
  runId: string;
  phaseId: string;
  sprintN: number;
  productSlug: string;
  channelId: string;
  client: DiscordClient;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: () => Promise<number>;
  reviewSummary: string;
  backoffDelays?: number[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fallback: () => Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
}

interface PollCursorStore {
  version: 1;
  cursors: PollCursor[];
}

async function loadCursor(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<string | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = await readArtifact(runDir, "state.md");
  const raw = map?.sections.get("Discord Poll Cursor");
  if (!raw) return null;
  try {
    const store = JSON.parse(raw) as PollCursorStore;
    const c = store.cursors.find((x) => x.phaseId === phaseId && x.sprintN === sprintN);
    return c?.lastSeenId ?? null;
  } catch {
    return null;
  }
}

async function saveCursor(flowDir: string, runId: string, cursor: PollCursor): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Discord Poll Cursor");
  let store: PollCursorStore = { version: 1, cursors: [] };
  if (raw) {
    try {
      store = JSON.parse(raw);
    } catch {
      /* reset */
    }
  }
  const idx = store.cursors.findIndex((x) => x.phaseId === cursor.phaseId && x.sprintN === cursor.sprintN);
  if (idx >= 0) store.cursors[idx] = cursor;
  else store.cursors.push(cursor);
  map.sections.set("Discord Poll Cursor", JSON.stringify(store, null, 2));
  await writeArtifact(runDir, "state.md", map);
}

export async function discordAwaitVerdict(
  args: DiscordAwaitVerdictArgs,
): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> {
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;

  const floor = verdictFloor(args.capUsd);
  const msgCap = maxVerdictMessages(args.capUsd);

  // Check budget before doing anything
  if ((await args.remainingUsd()) < floor) {
    await publish({
      client: args.client,
      channelId: args.channelId,
      type: "phase-event",
      content: "Budget exhausted; deferring decision to terminal.",
    }).catch(() => {});
    return { verdict: "abort", feedback: "budget-exhausted" };
  }

  // Load existing cursor or use empty string to poll from the beginning of channel history
  let lastSeenId = (await loadCursor(args.flowDir, args.runId, args.phaseId, args.sprintN)) ?? "";

  const startedAt = now();
  let msgCount = 0;
  let leaderFailures = 0;
  let unknownIntents = 0;
  const priorTurns: ConvoTurn[] = [];

  const botUserId = await args.client.getCurrentUserId().catch(() => "");

  while (true) {
    // Timeout check
    if (now() - startedAt > timeoutMs) {
      return { verdict: "abort", feedback: "[timeout-24h]" };
    }

    // Budget check
    if ((await args.remainingUsd()) < floor) {
      await publish({
        client: args.client,
        channelId: args.channelId,
        type: "phase-event",
        content: "Budget exhausted; aborting verdict capture.",
      }).catch(() => {});
      return { verdict: "abort", feedback: "budget-exhausted" };
    }

    // Message cap check
    if (msgCount >= msgCap) {
      await publish({
        client: args.client,
        channelId: args.channelId,
        type: "phase-event",
        content: "Reached per-sprint message cap; deferring to terminal.",
      }).catch(() => {});
      return args.fallback();
    }

    // Poll for new messages
    let msgs: Awaited<ReturnType<DiscordClient["getChannelMessages"]>>;
    try {
      msgs = await args.client.getChannelMessages(args.channelId, {
        afterId: lastSeenId,
        limit: MAX_MESSAGES_PER_POLL,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 404) return args.fallback();
      throw e;
    }

    // Filter out bot's own messages
    msgs = msgs.filter((m) => m.author.id !== botUserId);

    if (msgs.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const m of msgs) {
      // Check caps before processing each message
      if (msgCount >= msgCap) {
        await publish({
          client: args.client,
          channelId: args.channelId,
          type: "phase-event",
          content: "Reached per-sprint message cap; deferring to terminal.",
        }).catch(() => {});
        return args.fallback();
      }

      msgCount += 1;

      // Call leader to classify the message
      let raw: { content: string; costUsd: number };
      try {
        raw = await args.leader.generate({
          system: SYSTEM_PROMPT,
          prompt: buildConvoPrompt({
            reviewSummary: args.reviewSummary,
            productName: args.productSlug,
            priorTurns: priorTurns.slice(-10),
            newMessage: m.content,
          }),
          maxTokens: 400,
        });
        leaderFailures = 0;
      } catch {
        leaderFailures += 1;
        if (leaderFailures >= MAX_LEADER_FAILURES_BEFORE_FALLBACK) return args.fallback();
        await sleep((args.backoffDelays ?? [1000, 4000, 16000])[leaderFailures - 1] ?? 1000);
        continue;
      }

      const parsed = parseConvoReply(raw.content);
      const validIntents = ["accept", "reject", "abort", "discuss"] as const;
      const isValid = (validIntents as readonly string[]).includes(parsed.intent);

      if (!isValid) {
        unknownIntents += 1;
        if (unknownIntents >= MAX_UNKNOWN_INTENT_BEFORE_FALLBACK) return args.fallback();
      }

      const effectiveIntent = isValid ? parsed.intent : "discuss";

      // Post the bot reply BEFORE advancing cursor (resume safety)
      await publish({
        client: args.client,
        channelId: args.channelId,
        type: "phase-event",
        content: parsed.reply,
      }).catch(() => {});

      // Advance cursor AFTER posting reply
      lastSeenId = m.id;
      await saveCursor(args.flowDir, args.runId, {
        phaseId: args.phaseId,
        sprintN: args.sprintN,
        lastSeenId,
        lastPolledAtUtc: new Date().toISOString(),
      });

      priorTurns.push({ role: "customer", content: m.content });
      priorTurns.push({ role: "bot", content: parsed.reply });

      if (effectiveIntent === "accept" || effectiveIntent === "reject" || effectiveIntent === "abort") {
        return {
          verdict: effectiveIntent,
          feedback: effectiveIntent === "accept" ? undefined : m.content,
        };
      }
    }
  }
}
