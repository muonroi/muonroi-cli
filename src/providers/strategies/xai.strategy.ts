/**
 * src/providers/strategies/xai.strategy.ts
 *
 * Phase 12.2-G4 — xAI (Grok) strategy via `@ai-sdk/openai-compatible`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderCapabilities, type ProviderCapabilities } from "../capabilities.js";
import { OPENAI_COMPATIBLE_BASE_URLS } from "../endpoints.js";
import type { ProviderFactory } from "../runtime.js";
import type { ProviderId } from "../types.js";
import { BaseProviderStrategy, type CreateFactoryOpts } from "./base.strategy.js";
import { sanitizeToolCallArguments, splitParallelToolCalls } from "./thinking-mode.js";

export class XAIStrategy extends BaseProviderStrategy {
  readonly id: ProviderId = "xai";
  readonly capabilities: ProviderCapabilities = getProviderCapabilities("xai");

  createFactory(opts: CreateFactoryOpts): ProviderFactory {
    // Subscription OAuth path: `opts.headers` carries the Bearer token. xAI's
    // OAuth token is accepted on the same api.x.ai/v1 OpenAI-compatible host as
    // an API key (both /chat/completions and /responses), so the only change vs
    // the key path is injecting the header. `apiKey` falls back to a placeholder
    // because @ai-sdk/openai-compatible always sets an Authorization header from
    // it, but the explicit `headers` entry overrides that placeholder.
    const p = createOpenAICompatible({
      name: this.id,
      baseURL: opts.baseURL ?? OPENAI_COMPATIBLE_BASE_URLS.xai,
      apiKey: opts.apiKey ?? (opts.headers ? "oauth" : undefined),
      ...(opts.headers ? { headers: opts.headers } : {}),
      // grok-composer (Cursor Composer via xAI) emits BATCHES of parallel
      // tool_calls per assistant turn, and some carry empty/truncated
      // `arguments` strings. On the next multi-step request xAI rejects the
      // replayed history with 400 `invalid-argument: expected JSON object for
      // tool arguments` — a NON-transient error, so the bounded stream-retry
      // re-sends the same malformed history and the turn wedges (observed live
      // 2026-07-14, run mrkoeezk9a29: /ideal sprint impl made one tool-call
      // response then never progressed, 0 files, across every path). Mirror the
      // opencode-go/zai fix: split multi-tool-call assistant turns into
      // sequential single-call turns and repair empty/truncated tool arguments
      // to `{}` before they reach the upstream. Both helpers are no-ops unless
      // the failing pattern is present, so healthy requests are untouched.
      transformRequestBody: (body) => {
        const out: any = { ...body };
        if (Array.isArray(out.messages)) {
          out.messages = splitParallelToolCalls(out.messages);
          out.messages = sanitizeToolCallArguments(out.messages);
        }
        if ("response_format" in out) {
          const rf = out.response_format;
          if (rf == null || (typeof rf === "object" && Object.keys(rf).length === 0)) {
            delete out.response_format;
          }
        }
        return out;
      },
    });
    return (modelId: string) => p(modelId);
  }
}
