/**
 * src/reporter/auto-fire.ts
 *
 * B2 — Reporter auto-fire observer.
 *
 * Listens to product-loop lifecycle events (sprint_stage done/judgment,
 * sprint-halt, sprint-plan-committed) and posts concise summaries to the
 * configured Discord channel when:
 *   1. userSettings.reporter.autoFire === true (default=false, opt-in)
 *   2. A Discord channel is configured for the runId's productSlug
 *   3. The last auto-fire for this runId was more than 60s ago (debounce)
 *
 * This module is PURE OBSERVER — it never mutates sprint state or backlog.
 * It is wired into the product-loop event stream at the call site in
 * src/product-loop/index.ts (runPhasesPath / drainSprints).
 *
 * Model selection: always via pickCouncilTaskModel — zero hardcoded model ids.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatClient } from "../chat/types.js";
import { loadUserSettings } from "../utils/settings.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AutoFireEvent {
  kind: "sprint-done" | "sprint-halt" | "sprint-plan-committed";
  runId: string;
  flowDir: string;
  productSlug: string;
  /** For sprint-done: sprint index that just finished. */
  sprintN?: number;
  /** For sprint-done: overall completion %. */
  pct?: number;
  /** For sprint-done: pass or fail verdict. */
  verdict?: "pass" | "fail";
  /** For sprint-halt: reason string. */
  haltReason?: string;
  /** For sprint-plan-committed: number of sprints planned. */
  sprintCount?: number;
}

export interface AutoFireDeps {
  chat: ChatClient;
  /** Resolve the Discord channel id for a productSlug. Return null when not configured. */
  resolveChannelId: (productSlug: string) => Promise<string | null>;
}

// ─── Debounce map ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 60_000;
const lastFireMs = new Map<string, number>();

function isDebounced(runId: string): boolean {
  const last = lastFireMs.get(runId);
  if (!last) return false;
  return Date.now() - last < DEBOUNCE_MS;
}

function markFired(runId: string): void {
  lastFireMs.set(runId, Date.now());
}

/** Test helper: reset debounce state. */
export function __resetAutoFireDebounceForTests(): void {
  lastFireMs.clear();
}

// ─── Channel resolver (default impl) ──────────────────────────────────────

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

interface ChannelStore {
  version: number;
  items: Record<string, { channelId: string; guildId: string }>;
}

/**
 * Read discord-channels.json and return the channelId for a product slug.
 * Returns null if the file is absent or the slug has no entry.
 */
export async function defaultResolveChannelId(productSlug: string): Promise<string | null> {
  const channelsPath = path.join(muonroiHome(), "discord-channels.json");
  let raw: string;
  try {
    raw = await fs.readFile(channelsPath, "utf8");
  } catch {
    return null;
  }
  let store: ChannelStore;
  try {
    store = JSON.parse(raw) as ChannelStore;
  } catch {
    return null;
  }
  return store.items?.[productSlug]?.channelId ?? null;
}

// ─── Message builders ──────────────────────────────────────────────────────

function buildSprintDoneMessage(e: AutoFireEvent): string {
  const verdict = e.verdict === "pass" ? "✅" : "❌";
  const pctStr = e.pct !== undefined ? `${e.pct}%` : "?%";
  return `${verdict} **Sprint ${e.sprintN ?? "?"} done** — ${pctStr} overall completion${e.verdict ? ` (${e.verdict})` : ""}`;
}

function buildSprintHaltMessage(e: AutoFireEvent): string {
  return `⚠️ **Sprint halted** — ${e.haltReason ?? "unknown reason"}\n\nCheck \`.planning/runs/${e.runId}/\` for details.`;
}

function buildPlanCommittedMessage(e: AutoFireEvent): string {
  const n = e.sprintCount ?? "?";
  return `🚀 **Run started** — ${n} sprint${Number(n) !== 1 ? "s" : ""} planned (run: \`${e.runId}\`)`;
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Fire an auto-report event to Discord if all gates pass.
 *
 * Gates (all must pass):
 *   1. userSettings.reporter.autoFire === true
 *   2. Discord channel configured for productSlug
 *   3. Not debounced within 60s for this runId
 *
 * Non-throwing: errors are logged to stderr but never propagate to the caller
 * (the product loop must not crash due to reporter issues).
 */
export async function maybeAutoFire(event: AutoFireEvent, deps: AutoFireDeps): Promise<void> {
  try {
    // Gate 1: opt-in setting (default=false)
    const settings = loadUserSettings();
    if (!settings.reporter?.autoFire) return;

    // Gate 2: Discord channel configured
    const channelId = await deps.resolveChannelId(event.productSlug);
    if (!channelId) return;

    // Gate 3: debounce
    if (isDebounced(event.runId)) return;

    // Build message
    let message: string;
    switch (event.kind) {
      case "sprint-done":
        message = buildSprintDoneMessage(event);
        break;
      case "sprint-halt":
        message = buildSprintHaltMessage(event);
        break;
      case "sprint-plan-committed":
        message = buildPlanCommittedMessage(event);
        break;
      default:
        return;
    }

    await deps.chat.postMessage(channelId, message);
    markFired(event.runId);
  } catch (err) {
    // Best-effort — never let reporter failures break the product loop.
    process.stderr.write(`[reporter:auto-fire] error: ${(err as Error).message}\n`);
  }
}
