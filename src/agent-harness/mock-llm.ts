/**
 * src/agent-harness/mock-llm.ts
 *
 * Fixture-based mock LLM for deterministic E2E testing.
 * Loaded when --mock-llm <dir> is passed on the CLI.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterRequest, ProviderId, ProviderStream } from "../providers/types.js";

type Fixture = { responses: Array<{ match: string; text: string }> };

export type MockLlm = {
  complete(req: { prompt: string }): Promise<{ text: string }>;
};

export function createMockLlm(opts: { dir: string }): MockLlm {
  const files = readdirSync(opts.dir).filter((f) => f.endsWith(".json"));
  const fixtures: Fixture[] = files.map((f) => JSON.parse(readFileSync(join(opts.dir, f), "utf8")) as Fixture);
  return {
    async complete(req: { prompt: string }): Promise<{ text: string }> {
      for (const fx of fixtures) {
        for (const r of fx.responses) {
          if (r.match === "*") return { text: r.text };
          if (req.prompt.includes(r.match)) return { text: r.text };
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
