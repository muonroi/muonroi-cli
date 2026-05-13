import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CouncilLLM } from "../council/types.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { readManifest } from "./artifact-io.js";

/**
 * P5 - Cross-run workspace memory.
 *
 * Without this layer, each /ideal start runs cold and burns ~$5-10 re-doing
 * discovery on the same workspace. We load prior runs manifests + role
 * memories, filter by similarity to the current idea, decay by recency, then
 * condense via the leader LLM into a 2KB "Prior Decisions Context" string
 * that gets injected upstream of the clarifier and research debate.
 *
 * Storage: filesystem only (runs slash star slash memory slash star.md plus
 * runs slash star slash manifest.md). No vector store, no DB writes - 20-run
 * scan is linear and cheap. The condensed digest is persisted to state.md
 * under "Prior Decisions Context" so the user can audit what was injected.
 */

const MAX_DIGEST_BYTES = 2048;
const MAX_RUNS_TO_SCAN = 20;
const RECENCY_DECAY_DAYS = 30;
const MIN_KEYWORD_OVERLAP = 0.2;

export type PriorRunSummary = {
  runId: string;
  idea: string;
  verdictPass: boolean;
  failedCondition?: string;
  createdAt: Date;
  doneAt?: Date;
  memories: Map<string, string>;
  similarity: number;
  recency: number;
  weight: number;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "be",
  "been",
  "was",
  "were",
  "as",
  "by",
  "this",
  "that",
  "it",
  "i",
  "my",
  "we",
  "our",
  "you",
  "your",
  "they",
  "them",
  "their",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function recencyFactor(createdAt: Date, now: Date = new Date()): number {
  const days = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 0) return 1.0;
  if (days >= RECENCY_DECAY_DAYS) return 0.3;
  return 1.0 - (0.7 * days) / RECENCY_DECAY_DAYS;
}

async function listMemoryFiles(memoryDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const slot = entry.replace(/\.md$/, "");
    try {
      const text = await fs.readFile(path.join(memoryDir, entry), "utf8");
      if (text.trim().length > 0) result.set(slot, text);
    } catch {
      /* skip unreadable */
    }
  }
  return result;
}

/**
 * Discover prior runs under flowDir/runs, excluding the current run.
 * Returns runs that pass the similarity gate, ranked by weight, capped at
 * MAX_RUNS_TO_SCAN.
 */
export async function discoverPriorRuns(
  flowDir: string,
  currentRunId: string,
  currentIdea: string,
): Promise<PriorRunSummary[]> {
  const runsRoot = path.join(flowDir, "runs");
  let runIds: string[];
  try {
    runIds = await fs.readdir(runsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const currentTokens = tokenize(currentIdea);
  if (currentTokens.size === 0) return [];

  const candidates: PriorRunSummary[] = [];
  for (const runId of runIds) {
    if (runId === currentRunId) continue;
    const manifest = await readManifest(flowDir, runId).catch(() => null);
    if (!manifest || !manifest.idea) continue;

    const sim = jaccard(currentTokens, tokenize(manifest.idea));
    if (sim < MIN_KEYWORD_OVERLAP) continue;

    const rec = recencyFactor(manifest.createdAt);
    const memoryDir = path.join(runsRoot, runId, "memory");
    const memories = await listMemoryFiles(memoryDir);

    candidates.push({
      runId,
      idea: manifest.idea,
      verdictPass: manifest.verdict?.pass ?? false,
      failedCondition: manifest.verdict?.failedCondition,
      createdAt: manifest.createdAt,
      doneAt: manifest.doneAt,
      memories,
      similarity: sim,
      recency: rec,
      weight: sim * rec,
    });
  }

  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, MAX_RUNS_TO_SCAN);
}

/**
 * Build raw material for the LLM to condense. Caps total input at 8KB.
 */
function buildCondensationInput(runs: PriorRunSummary[]): string {
  const MAX_INPUT_BYTES = 8192;
  const blocks: string[] = [];
  let bytes = 0;
  for (const r of runs) {
    let status: string;
    if (r.verdictPass) {
      status = "SHIPPED";
    } else if (r.failedCondition) {
      status = "HALTED (" + r.failedCondition + ")";
    } else {
      status = "INCOMPLETE";
    }

    const memSnippets: string[] = [];
    for (const [slot, text] of r.memories) {
      const head = text.trim().slice(0, 400);
      memSnippets.push("  [" + slot + "] " + head);
    }

    const lines: string[] = [];
    lines.push("## Run " + r.runId + " - " + status);
    lines.push("Idea: " + r.idea);
    const created = r.createdAt.toISOString().slice(0, 10);
    const simStr = r.similarity.toFixed(2);
    const recStr = r.recency.toFixed(2);
    lines.push("Created: " + created + " | similarity=" + simStr + " | recency=" + recStr);
    if (memSnippets.length > 0) {
      lines.push("Roles:");
      lines.push(memSnippets.join("\n"));
    }
    const block = lines.join("\n") + "\n";

    const blockBytes = Buffer.byteLength(block);
    if (bytes + blockBytes > MAX_INPUT_BYTES) break;
    blocks.push(block);
    bytes += blockBytes;
  }
  return blocks.join("\n");
}

/**
 * Condense prior-run material into a 2KB Prior Decisions Context string.
 */
export async function condensePriorRuns(
  runs: PriorRunSummary[],
  leaderModelId: string,
  llm: CouncilLLM,
): Promise<string> {
  if (runs.length === 0) return "";

  const system =
    "You are summarizing prior /ideal runs for an engineering team about to start a similar product. " +
    "Output a tight, bulleted brief (max 1500 characters) covering ONLY reusable knowledge: " +
    "architectural decisions made, approaches that were abandoned and why, recurring risks, " +
    "and model/tooling preferences that worked. " +
    "Skip per-sprint trivia, status updates, and anything specific to the prior idea that does " +
    "not generalize. If a run shipped successfully, lead with what worked; if it halted, lead with " +
    "why and what to avoid. Plain markdown, no preamble.";

  const ideaLine = runs.length > 0 ? "Current idea: (see runs below for context)" : "Current idea:";
  const prompt = ideaLine + "\n\n" + buildCondensationInput(runs);

  try {
    const raw = await llm.generate(leaderModelId, system, prompt, 1024);
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return "";
    if (Buffer.byteLength(trimmed) <= MAX_DIGEST_BYTES) return trimmed;
    return trimmed.slice(0, MAX_DIGEST_BYTES).trim() + "...";
  } catch {
    return "";
  }
}

/**
 * Top-level helper. Discover, condense, persist audit. Returns the digest
 * string (empty when nothing to inject).
 */
export async function buildPriorContext(opts: {
  flowDir: string;
  runId: string;
  idea: string;
  leaderModelId: string;
  llm: CouncilLLM;
  optOut?: boolean;
}): Promise<{ digest: string; runs: PriorRunSummary[] }> {
  if (opts.optOut) return { digest: "", runs: [] };

  const runs = await discoverPriorRuns(opts.flowDir, opts.runId, opts.idea);
  const digest = await condensePriorRuns(runs, opts.leaderModelId, opts.llm);

  const runDir = path.join(opts.flowDir, "runs", opts.runId);
  try {
    const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
    if (runs.length === 0) {
      stateMap.sections.set("Prior Decisions Context", "_(no qualifying prior runs in this workspace)_");
    } else {
      const auditLines: string[] = [];
      for (const r of runs) {
        const status = r.verdictPass ? "SHIPPED" : (r.failedCondition ?? "INCOMPLETE");
        const sim = r.similarity.toFixed(2);
        const rec = r.recency.toFixed(2);
        auditLines.push("- " + r.runId + " | sim=" + sim + " rec=" + rec + " | " + status);
      }
      const digestBody = digest || "_(empty - leader returned no useful content)_";
      const sourcesBlock = "**Sources:**\n" + auditLines.join("\n");
      const digestBlock = "**Condensed digest:**\n" + digestBody;
      stateMap.sections.set("Prior Decisions Context", sourcesBlock + "\n\n" + digestBlock);
    }
    await writeArtifact(runDir, "state.md", stateMap);
  } catch {
    /* non-critical */
  }

  return { digest, runs };
}

/**
 * Format the digest for injection into clarifier/debate conversationContext.
 */
export function formatPriorContextForPrompt(digest: string): string {
  const trimmed = digest.trim();
  if (!trimmed) return "";
  const header = "\n## Prior Decisions Context (from earlier /ideal runs on this workspace)\n";
  const intro =
    "These are reusable lessons - treat as defaults you may override with explicit reason, not as hard requirements.\n\n";
  return header + intro + trimmed + "\n";
}
