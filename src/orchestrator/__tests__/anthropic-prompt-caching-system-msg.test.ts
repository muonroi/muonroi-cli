/**
 * `applyAnthropicPromptCaching` must not rewrite a system message into content
 * parts.
 *
 * The AI SDK's ModelMessage schema allows content PARTS only on user/assistant/
 * tool messages; a system message's content must be a plain string. The cache
 * breakpoint used to be stamped on `messages.at(-1)` regardless of role, so any
 * turn whose last message was a system message died in `streamText` validation
 * with `AI_InvalidPromptError: The messages do not match the ModelMessage[]
 * schema` — before a single byte went to the provider, with zero output.
 *
 * The trailing system message is not exotic: the EE recall-ledger pushes
 * `{role:"system", content:"↳ N earlier EE hint(s) still unrated…"}` at turn
 * start whenever hints are awaiting a verdict (message-processor.ts). Session
 * e8a11770b19b hit it on a plain "hello", and the same helper is wired into
 * stream-runner (sub-agents) and tool-engine (the tool loop), so all three
 * surfaces were exposed.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { applyAnthropicPromptCaching } from "../subagent-compactor.js";

const CLAUDE = "claude-sonnet-5";
const EE_NAG = "↳ 5 earlier EE hint(s) still unrated. Rate the one(s) you actually acted on…";

function cacheControlOf(msg: ModelMessage | undefined): unknown {
  const content = msg?.content;
  if (!Array.isArray(content)) return undefined;
  const last = content[content.length - 1] as { providerOptions?: { anthropic?: unknown } } | undefined;
  return last?.providerOptions?.anthropic;
}

describe("applyAnthropicPromptCaching — trailing system message", () => {
  it("leaves a trailing system message's content a string", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "system", content: EE_NAG },
    ];

    const out = applyAnthropicPromptCaching(messages, CLAUDE);

    expect(typeof out[1]?.content).toBe("string");
    expect(out[1]?.content).toBe(EE_NAG);
  });

  it("anchors the breakpoint on the last parts-capable message instead", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "system", content: EE_NAG },
    ];

    const out = applyAnthropicPromptCaching(messages, CLAUDE);

    expect(cacheControlOf(out[0])).toEqual({ cacheControl: { type: "ephemeral" } });
  });

  it("skips past MULTIPLE trailing system messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "system", content: "guidance" },
      { role: "system", content: EE_NAG },
    ];

    const out = applyAnthropicPromptCaching(messages, CLAUDE);

    expect(cacheControlOf(out[0])).toEqual({ cacheControl: { type: "ephemeral" } });
    expect(typeof out[1]?.content).toBe("string");
    expect(typeof out[2]?.content).toBe("string");
  });

  it("returns an all-system prompt untouched rather than corrupting one", () => {
    const messages: ModelMessage[] = [{ role: "system", content: EE_NAG }];

    const out = applyAnthropicPromptCaching(messages, CLAUDE);

    expect(out).toEqual(messages);
  });

  it("still stamps the last user message when nothing trails it (unchanged path)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];

    const out = applyAnthropicPromptCaching(messages, CLAUDE);

    expect(cacheControlOf(out[2])).toEqual({ cacheControl: { type: "ephemeral" } });
    expect(out[0]?.content).toBe("first");
  });

  it("is a no-op for a non-claude model", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    expect(applyAnthropicPromptCaching(messages, "deepseek-v4-flash")).toEqual(messages);
  });
});
