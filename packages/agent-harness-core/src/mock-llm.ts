/**
 * src/agent-harness/mock-llm.ts
 *
 * Fixture-based mock LLM for deterministic E2E testing.
 * Loaded when --mock-llm <dir> is passed on the CLI.
 *
 * Two fixture shapes are supported (detected by key presence):
 *
 * ResponsesFixture — stateless, first-match-wins (original behavior):
 *   { "responses": [{ "match": "string or *", "text": "..." }] }
 *   Error injection: { "match": "...", "error": "message" } — throws instead of returning text.
 *
 * SequenceFixture — stateful, calls consumed in order:
 *   { "sequence": [{ "text": "...", "match": "optional substring" }] }
 *   Error injection in sequence: { "error": "message", "match": "optional substring" }
 *   - Entries are consumed in order per MockLlm instance.
 *   - If an entry has "match", it is only consumed when the prompt includes it;
 *     otherwise consumed unconditionally.
 *   - When the sequence is exhausted, the last entry repeats (no crash).
 *   - Sequence fixtures are tried before responses fixtures.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal provider types inlined here to avoid cross-package rootDir violation.
// These are structural duplicates of src/providers/types.ts — keep in sync.
// ---------------------------------------------------------------------------
type StreamChunk =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; output: unknown }
  | {
      kind: "finish";
      reason: "stop" | "length" | "tool-calls" | "error";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { kind: "error"; error: Error };

type ProviderId = "anthropic" | "openai" | "google" | "deepseek" | "siliconflow" | "xai" | "ollama";

interface AdapterRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  tools?: unknown[];
  toolChoice?: unknown;
  abortSignal?: AbortSignal;
}

type ProviderStream = AsyncGenerator<StreamChunk, void, unknown>;

interface Adapter {
  readonly id: ProviderId;
  stream(req: AdapterRequest): ProviderStream;
}

type SequenceEntry = { text?: string; error?: string; match?: string };
type SequenceFixture = { sequence: SequenceEntry[] };
type ResponseEntry = { match: string; text?: string; error?: string };
type ResponsesFixture = { responses: ResponseEntry[] };
type Fixture = SequenceFixture | ResponsesFixture;

function isSequenceFixture(fx: Fixture): fx is SequenceFixture {
  return "sequence" in fx && Array.isArray((fx as SequenceFixture).sequence);
}

export type MockLlm = {
  complete(req: { prompt: string }): Promise<{ text: string }>;
};

export function createMockLlm(opts: { dir: string }): MockLlm {
  const files = readdirSync(opts.dir).filter((f) => f.endsWith(".json"));
  const fixtures: Fixture[] = files.map((f) => JSON.parse(readFileSync(join(opts.dir, f), "utf8")) as Fixture);

  // Per-fixture sequence counters: index into sequence array for each SequenceFixture.
  const seqCounters = new Map<SequenceFixture, number>();
  for (const fx of fixtures) {
    if (isSequenceFixture(fx)) {
      seqCounters.set(fx, 0);
    }
  }

  return {
    async complete(req: { prompt: string }): Promise<{ text: string }> {
      // 1. Try sequence fixtures first (more specific).
      for (const fx of fixtures) {
        if (!isSequenceFixture(fx)) continue;
        const seq = fx.sequence;
        if (seq.length === 0) continue;
        const startIdx = seqCounters.get(fx) ?? 0;
        // Scan forward from current position for an entry that matches (or has no constraint).
        // Entries with a non-matching match constraint are walked over, but the counter
        // only advances past them when consumed — they remain as the next candidate.
        const clampedStart = Math.min(startIdx, seq.length - 1);
        let chosen: SequenceEntry | undefined;
        let nextIdx = clampedStart;
        for (let i = clampedStart; i < seq.length; i++) {
          const entry = seq[i]!;
          if (entry.match === undefined || req.prompt.includes(entry.match)) {
            chosen = entry;
            nextIdx = Math.min(i + 1, seq.length - 1 + 1);
            break;
          }
        }
        if (chosen === undefined) continue; // No entry in this fixture matches — try next fixture.
        seqCounters.set(fx, nextIdx);
        if (chosen.error !== undefined) throw new Error(chosen.error);
        return { text: chosen.text ?? "" };
      }

      // 2. Try responses fixtures: non-wildcard matches first.
      for (const fx of fixtures) {
        if (isSequenceFixture(fx)) continue;
        for (const r of fx.responses) {
          if (r.match !== "*" && req.prompt.includes(r.match)) {
            if (r.error !== undefined) throw new Error(r.error);
            return { text: r.text ?? "" };
          }
        }
      }

      // 3. Wildcard fallback from responses fixtures.
      for (const fx of fixtures) {
        if (isSequenceFixture(fx)) continue;
        for (const r of fx.responses) {
          if (r.match === "*") {
            if (r.error !== undefined) throw new Error(r.error);
            return { text: r.text ?? "" };
          }
        }
      }

      throw new Error(`no fixture matches prompt: ${req.prompt.slice(0, 40)}`);
    },
  };
}

/**
 * Adapter helper — turn MockLlm into the Adapter interface for the provider hook.
 * Used by createAdapter() in src/providers/adapter.ts via the globalThis short-circuit.
 */
export function createMockAdapterFactory(mock: MockLlm) {
  return function createMockAdapter(id: string): Adapter {
    return {
      id: id as ProviderId,
      async *stream(req: AdapterRequest): ProviderStream {
        const prompt = req.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n");
        const res = await mock.complete({ prompt });
        yield { kind: "text-delta", text: res.text };
        yield { kind: "finish", reason: "stop" };
      },
    };
  };
}
