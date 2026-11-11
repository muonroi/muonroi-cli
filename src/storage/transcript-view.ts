import type { ModelMessage } from "ai";
import { createCompactionSummaryMessage } from "../orchestrator/compaction";
import { applyPersistedShrink, type PersistedShrinkSpec } from "../orchestrator/compaction-budget";

export interface PersistedCompaction {
  firstKeptSeq: number;
  summary: string;
  tokensBefore: number;
  createdAt: Date;
  /**
   * Retained-set decisions of the live compaction (dropped rows, budget level).
   * Absent on rows written before the spec existed and on compactions that did
   * not run the host budget pass (manual /compact, sub-session absorb).
   */
  shrink?: PersistedShrinkSpec;
}

export interface LoadedTranscriptState {
  messages: ModelMessage[];
  seqs: Array<number | null>;
  timestamps: Date[];
  compaction: PersistedCompaction | null;
}

export interface EffectiveTranscriptOptions {
  /**
   * Apply the compaction's persisted shrink spec (default). The model-facing
   * history needs it; display surfaces that show the canonical suffix pass
   * false so the user still sees every row.
   */
  applyShrink?: boolean;
}

export function buildEffectiveTranscript(
  messages: ModelMessage[],
  seqs: number[],
  timestamps: Date[],
  compaction: PersistedCompaction | null,
  options: EffectiveTranscriptOptions = {},
): LoadedTranscriptState {
  if (!compaction) {
    return {
      messages: [...messages],
      seqs: [...seqs],
      timestamps: [...timestamps],
      compaction: null,
    };
  }

  const firstKeptIndex = seqs.findIndex((seq) => seq >= compaction.firstKeptSeq);
  let keptIndex = firstKeptIndex >= 0 ? firstKeptIndex : messages.length;

  // Anti-mù / Resilience: if firstKeptSeq landed on a `tool` message (e.g. due to seq array
  // misalignment or forced cut), we MUST step back to include its preceding `assistant` message.
  // Otherwise Vercel AI SDK throws: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
  if (keptIndex > 0 && messages[keptIndex]?.role === "tool") {
    keptIndex -= 1;
  }

  let keptMessages = messages.slice(keptIndex);
  let keptSeqs = seqs.slice(keptIndex);
  let keptTimestamps = timestamps.slice(keptIndex);

  if (compaction.shrink && options.applyShrink !== false) {
    const view = applyPersistedShrink(keptMessages, keptSeqs, compaction.shrink);
    const shrunkSeqs = view.indices.map((i) => keptSeqs[i]!);
    keptTimestamps = view.indices.map((i) => keptTimestamps[i]!);
    keptSeqs = shrunkSeqs;
    keptMessages = view.messages;
  }

  return {
    messages: [createCompactionSummaryMessage(compaction.summary), ...keptMessages],
    seqs: [null, ...keptSeqs],
    timestamps: [compaction.createdAt, ...keptTimestamps],
    compaction,
  };
}
