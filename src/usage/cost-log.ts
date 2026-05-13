/**
 * src/usage/cost-log.ts
 *
 * Lightweight, append-only JSONL log of every LLM call across the CLI.
 * Complements the monthly ledger and per-product ledger by capturing calls
 * that don't have a productRunId (orchestrator, compaction, council, PIL, ...).
 *
 * Goal: answer "where did the cost grow?" by callsite / role / phase, even
 * for traffic that bypasses reserve/commit. Writes are best-effort — failures
 * never block the model call.
 *
 * Path: ~/.muonroi-cli/usage/cost-log.jsonl  (rotates daily by date suffix)
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { projectCostUSD } from "./estimator.js";
import type { CostMeta } from "./product-ledger.js";

export interface CostLogEntry extends CostMeta {
  ts: number;
  provider: string;
  model: string;
  estimatedUsd: number;
  productRunId?: string;
  /**
   * Free-form chars/tokens breakdown per logical prompt component.
   * Keys: staticPrefix, dynamicSuffix, playwrightGuidance, pilSuffix,
   *       messages, tools, toolNames, etc. Used by orchestrator to
   *       attribute the 17K-token system prompt to specific parts.
   */
  breakdown?: Record<string, number>;
}

function muonroiHome(homeOverride?: string): string {
  return homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function logPath(homeOverride?: string): string {
  return path.join(muonroiHome(homeOverride), "usage", `cost-log-${todayUtc()}.jsonl`);
}

/**
 * Append one entry. Best-effort: errors are swallowed so a logging fault
 * cannot break the calling LLM request.
 */
export async function appendCostLog(entry: CostLogEntry, homeOverride?: string): Promise<void> {
  try {
    const fp = logPath(homeOverride);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, `${JSON.stringify(entry)}\n`);
  } catch {
    // intentionally swallow — diagnostics must not break the hot path
  }
}

/**
 * Metered wrapper for any LLM call.
 *
 * Use this at every `generateText` / `streamText` / `llm.generate` site that
 * does NOT already go through the per-product ledger. It records:
 *   - estimated cost (cheap, from chars/4)
 *   - actual tokens IF the caller can supply them from `result.usage`
 *   - callsite/role/phase/iteration tags for groupable reports
 *
 * The wrapper does not enforce the cap — orchestrator/compaction paths run
 * outside reserve/commit by design (Phase G). It exists to MEASURE.
 */
export async function meteredGenerate<T>(
  args: {
    provider: string;
    model: string;
    systemChars: number;
    promptChars: number;
    estOutputTokens?: number;
    meta?: CostMeta;
    homeOverride?: string;
  },
  fn: () => Promise<{
    result: T;
    actualInputTokens?: number;
    actualOutputTokens?: number;
    cachedInputTokens?: number;
    stepCount?: number;
  }>,
): Promise<T> {
  const estIn = Math.ceil((args.systemChars + args.promptChars) / 4);
  const estOut = args.estOutputTokens ?? 2048;
  const startedAt = Date.now();
  try {
    const { result, actualInputTokens, actualOutputTokens, cachedInputTokens, stepCount } = await fn();
    const inTok = actualInputTokens ?? estIn;
    const outTok = actualOutputTokens ?? Math.max(1, Math.ceil(estOut / 4));
    const usd = projectCostUSD(args.provider, args.model, inTok, outTok);
    await appendCostLog(
      {
        ts: startedAt,
        provider: args.provider,
        model: args.model,
        estimatedUsd: usd,
        systemChars: args.systemChars,
        promptChars: args.promptChars,
        estInputTokens: estIn,
        actualInputTokens,
        actualOutputTokens,
        cachedInputTokens,
        stepCount,
        durationMs: Date.now() - startedAt,
        ...args.meta,
      },
      args.homeOverride,
    );
    return result;
  } catch (err) {
    // Still record the attempt so retries/failures show up in the bloat report.
    await appendCostLog(
      {
        ts: startedAt,
        provider: args.provider,
        model: args.model,
        estimatedUsd: 0,
        systemChars: args.systemChars,
        promptChars: args.promptChars,
        estInputTokens: estIn,
        durationMs: Date.now() - startedAt,
        ...args.meta,
        callsite: `${args.meta?.callsite ?? "unknown"}:error`,
      },
      args.homeOverride,
    );
    throw err;
  }
}

/**
 * Read all cost-log entries for the given UTC date (default = today).
 * Returns empty array if the file does not exist.
 */
export async function readCostLog(date?: string, homeOverride?: string): Promise<CostLogEntry[]> {
  const day = date ?? todayUtc();
  const fp = path.join(muonroiHome(homeOverride), "usage", `cost-log-${day}.jsonl`);
  try {
    const content = await fs.readFile(fp, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as CostLogEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
