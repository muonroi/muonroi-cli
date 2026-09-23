/**
 * src/usage/decision-log.ts
 *
 * Per-turn orchestrator decision log. Captures the binary YES/NO decisions
 * that gate expensive paths (auto-council, post-turn compaction, mode switch)
 * along with the reason so reports can answer "why did we burn $0.30 on a
 * council just now?" or "we paid for compaction every 4 turns — is the
 * threshold tuned wrong?".
 *
 * Companion to:
 *   - cost-log.ts (every LLM call: model, tokens, cost)
 *   - pil/budget-log.ts (every pipeline run: per-layer prompt growth)
 *
 * Best-effort append; failures never break the orchestrator.
 *
 * Path: ~/.muonroi-cli/usage/decision-log-<UTC-date>.jsonl
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "../utils/logger.js";

export type DecisionKind =
  | "auto-council"
  | "post-turn-compact"
  | "router-tier"
  | "permission-override"
  | "yolo-override"
  | "scope-gate";

export interface DecisionLogEntry {
  ts: number;
  sessionId?: string | null;
  kind: DecisionKind;
  /** true if the expensive path was taken; false if skipped. */
  taken: boolean;
  /** Short human-readable explanation suitable for a report column. */
  reason: string;
  /** Optional free-form data — taskType, confidence, model chosen, etc. */
  meta?: Record<string, unknown>;
}

function muonroiHome(homeOverride?: string): string {
  return homeOverride ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function logPath(homeOverride?: string): string {
  return path.join(muonroiHome(homeOverride), "usage", `decision-log-${todayUtc()}.jsonl`);
}

export async function appendDecisionLog(entry: DecisionLogEntry, homeOverride?: string): Promise<void> {
  try {
    const fp = logPath(homeOverride);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    // Redact the SERIALIZED line, at the one choke point every caller shares,
    // rather than per-caller: `meta` is typed `Record<string, unknown>` so no
    // call site is structurally prevented from putting a credential in it, and
    // one already does. `permission-mode.ts`'s `appendAudit` passes
    // `meta: { context: event.context }` verbatim, and `context.command` is the
    // raw shell command the MODEL proposed — `export DEEPSEEK_API_KEY=…` or a
    // `curl -H "x-api-key: …"` landed here in plain text on every yolo /
    // permission override.
    //
    // `redactSecrets` is span-level, so `reason`, `kind` and `taken` stay fully
    // readable and the command still shows WHICH credential it touched. It is
    // also JSON-safe by contract (see its doc comment), which matters here
    // because `readDecisionLog` JSON.parses these lines back.
    await fs.appendFile(fp, `${redactSecrets(JSON.stringify(entry))}\n`);
  } catch {
    // intentionally swallow — diagnostics must not break the turn
  }
}

export async function readDecisionLog(date?: string, homeOverride?: string): Promise<DecisionLogEntry[]> {
  const day = date ?? todayUtc();
  const fp = path.join(muonroiHome(homeOverride), "usage", `decision-log-${day}.jsonl`);
  try {
    const content = await fs.readFile(fp, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as DecisionLogEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function listDecisionLogDates(homeOverride?: string): Promise<string[]> {
  const dir = path.join(muonroiHome(homeOverride), "usage");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.startsWith("decision-log-") && f.endsWith(".jsonl"))
      .map((f) => f.replace(/^decision-log-/, "").replace(/\.jsonl$/, ""))
      .sort();
  } catch {
    return [];
  }
}
