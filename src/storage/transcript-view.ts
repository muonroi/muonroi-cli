import type { ModelMessage } from "ai";
import { createCompactionSummaryMessage } from "../orchestrator/compaction";

export interface PersistedCompaction {
  firstKeptSeq: number;
  summary: string;
  tokensBefore: number;
  createdAt: Date;
}

export interface LoadedTranscriptState {
  messages: ModelMessage[];
  seqs: Array<number | null>;
  timestamps: Date[];
  compaction: PersistedCompaction | null;
}

export function buildEffectiveTranscript(
  messages: ModelMessage[],
  seqs: number[],
  timestamps: Date[],
  compaction: PersistedCompaction | null,
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

  const keptMessages = messages.slice(keptIndex);
  const keptSeqs = seqs.slice(keptIndex);
  const keptTimestamps = timestamps.slice(keptIndex);

  return {
    messages: [createCompactionSummaryMessage(compaction.summary), ...keptMessages],
    seqs: [null, ...keptSeqs],
    timestamps: [compaction.createdAt, ...keptTimestamps],
    compaction,
  };
}
