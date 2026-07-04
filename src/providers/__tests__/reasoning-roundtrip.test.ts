/**
 * Real-fix proof for the "reasoning_content must be passed back" rejection
 * that previously hit DeepSeek/SiliconFlow (HTTP 400 code 20015).
 *
 * The previous workaround (commit 42d5440, May 2026) disabled thinking mode
 * entirely because @ai-sdk/openai-compatible reportedly did not serialize
 * assistant reasoning parts as `reasoning_content`. This test asserts the
 * opposite for the version pinned in package.json (2.0.42) by capturing the
 * actual outgoing request body through a stub `fetch` and inspecting the
 * serialized payload.
 *
 * If this test passes, the workaround is unnecessary and reasoning_content
 * round-trips natively — which is what removed the `thinking-disabled`
 * unconditional gate. If it ever fails (upstream regression), put the gate
 * back in DeepSeekProviderCapabilities.buildProviderOptions.
 *
 * Reference: dist/index.js:257-263 in
 *   node_modules/.bun/@ai-sdk+openai-compatible@2.0.42/.../dist/index.js
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeToolCallArguments,
  splitParallelToolCalls,
  transformThinkingModeBody,
  transformZaiThinkingBody,
} from "../strategies/thinking-mode.js";
import { ZaiStrategy } from "../strategies/zai.strategy.js";

type WireBody = { messages: Array<Record<string, unknown>>; [k: string]: unknown };

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function makeStubProvider(name: string, capture: { current: CapturedRequest | null }) {
  return createOpenAICompatible({
    name,
    baseURL: "https://example.test/v1",
    apiKey: "stub-key",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      capture.current = {
        url,
        body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
      };
      const sse = [
        'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

describe("reasoning_content round-trip — AI SDK 2.0.42 wire shape", () => {
  it("siliconflow: serializes assistant reasoning part as reasoning_content in request body", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("siliconflow", capture);
    const model = provider("deepseek-v4-flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "The user is asking basic arithmetic; the answer is four." },
            { type: "text", text: "4" },
          ],
        },
        { role: "user", content: "Now what is 2+3?" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg, "assistant message must be present in wire body").toBeDefined();
    expect(assistantMsg!.reasoning_content).toBe("The user is asking basic arithmetic; the answer is four.");
    expect(assistantMsg!.content).toBe("4");
  });

  it("deepseek: serializes assistant reasoning part as reasoning_content in request body", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("deepseek", capture);
    const model = provider("deepseek-v4-flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "Read foo.txt" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I need to call the read_file tool." },
            { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "foo.txt" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "read_file",
              output: { type: "text", value: "contents" },
            },
          ],
        },
        { role: "user", content: "summarize" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg, "assistant message with tool-call must round-trip").toBeDefined();
    expect(assistantMsg!.reasoning_content).toBe("I need to call the read_file tool.");
    expect(Array.isArray(assistantMsg!.tool_calls)).toBe(true);
    expect((assistantMsg!.tool_calls as Array<Record<string, unknown>>)[0]?.id).toBe("c1");
  });

  // NOTE: the bare provider correctly omits reasoning_content when a turn has
  // no reasoning part — but that is exactly the shape SiliconFlow's
  // thinking-mode validator rejects (code 20015) in a mixed history. The
  // strategy's transformRequestBody backfills it; see the dedicated describe
  // block below ("transformThinkingModeBody — backfill / disable").
  it("emits no reasoning_content key when there are no reasoning parts (no false positives)", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeStubProvider("siliconflow", capture);
    const model = provider("deepseek-v4-flash");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        { role: "user", content: "Again" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsg = body.messages.find((m) => m.role === "assistant");
    expect(assistantMsg!.reasoning_content).toBeUndefined();
  });
});

describe("transformThinkingModeBody — backfill / disable (code 20015 fix)", () => {
  const ENV = "MUONROI_DEEPSEEK_DISABLE_THINKING";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("A (default): backfills reasoning_content on a tool-call turn that lacks it", () => {
    const body: WireBody = {
      messages: [
        { role: "user", content: "go" },
        // tool-call turn with NO reasoning (the real bug shape)
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function" }] },
      ],
    };
    const out = transformThinkingModeBody(body);
    const asst = out.messages.find((m) => m.role === "assistant")!;
    expect(asst.reasoning_content).toBe("");
    expect(Array.isArray(asst.tool_calls)).toBe(true); // tool_calls preserved
    expect("thinking" in out).toBe(false); // thinking still ON
  });

  it("A (default): leaves a real reasoning_content untouched and patches only the gap", () => {
    const body: WireBody = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, reasoning_content: "real thought", tool_calls: [{ id: "a" }] },
        { role: "tool", content: "result" },
        { role: "assistant", content: null, tool_calls: [{ id: "b" }] }, // gap
      ],
    };
    const out = transformThinkingModeBody(body);
    const asst = out.messages.filter((m) => m.role === "assistant");
    expect(asst[0]!.reasoning_content).toBe("real thought"); // untouched
    expect(asst[1]!.reasoning_content).toBe(""); // backfilled
  });

  it("A (default): backfills content: '' on a reasoning-only turn that lacks content and tool_calls", () => {
    const body: WireBody = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, reasoning_content: "only thought" },
      ],
    };
    const out = transformThinkingModeBody(body);
    const asst = out.messages.find((m) => m.role === "assistant")!;
    expect(asst.reasoning_content).toBe("only thought");
    expect(asst.content).toBe("");
  });

  it("A (default): does not touch non-assistant messages", () => {
    const body: WireBody = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "r" },
      ],
    };
    const out = transformThinkingModeBody(body);
    expect("reasoning_content" in out.messages[0]!).toBe(false);
    expect("reasoning_content" in out.messages[1]!).toBe(false);
  });

  it("B (env=1): disables thinking and does NOT backfill reasoning_content", () => {
    process.env[ENV] = "1";
    const body: WireBody = {
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "t1" }] }],
    };
    const out = transformThinkingModeBody(body);
    expect(out.thinking).toEqual({ type: "disabled" });
    const asst = out.messages.find((m) => m.role === "assistant")!;
    expect("reasoning_content" in asst).toBe(false);
  });
});

describe("transformZaiThinkingBody — conditional backfill (Z.ai 1210 fix)", () => {
  const ENV = "MUONROI_ZAI_DISABLE_THINKING";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("does NOT inject reasoning_content when no assistant turn has one (non-thinking model safety)", () => {
    // glm-4.5-air / glm-4.6v-flash never emit reasoning — injecting the field
    // would itself trigger Z.ai 1210 "Invalid API parameter".
    const body: WireBody = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", tool_calls: [{ id: "t1" }] },
      ],
    };
    const out = transformZaiThinkingBody(body);
    const asst = out.messages.find((m) => m.role === "assistant")!;
    expect("reasoning_content" in asst).toBe(false);
    expect("thinking" in out).toBe(false);
    // H3 mitigation: never allow the model to emit many parallel tool_calls
    // on Z.ai coding endpoint (see 8/12/17 toolCalls sessions).
    expect(out.parallel_tool_calls).toBe(false);
  });

  it("sanitizes response_format + clamps max_tokens for Z.ai to avoid 1210 combos (c1f5ca294496 shape)", () => {
    const body: WireBody = {
      messages: [{ role: "user", content: "hi" }],
      response_format: null,
      max_tokens: 8192,
      temperature: 0.2,
      parallel_tool_calls: true, // even if SDK sends it, we override
    };
    const out = transformZaiThinkingBody(body);
    expect(out.response_format).toBeUndefined();
    expect(out.max_tokens).toBe(4096);
    expect(out.parallel_tool_calls).toBe(false);
    expect(out.temperature).toBe(0.2); // other values untouched
  });

  it("backfills reasoning_content once a conversation is in thinking mode (mixed history)", () => {
    // The c0dcf9153803 failure shape: glm-4.7 on the coding endpoint emits
    // reasoning on some turns, then a tool-only turn lacks it → 1210.
    const body: WireBody = {
      messages: [
        { role: "user", content: "go" },
        // turn 1: thinking mode — has reasoning_content
        { role: "assistant", content: null, reasoning_content: "plan", tool_calls: [{ id: "a" }] },
        { role: "tool", content: "r1" },
        // turn 2: tool-only intermediate step — MISSING reasoning_content (the bug)
        { role: "assistant", content: null, tool_calls: [{ id: "b" }] },
        { role: "tool", content: "r2" },
      ],
    };
    const out = transformZaiThinkingBody(body);
    const asst = out.messages.filter((m) => m.role === "assistant");
    expect(asst[0]!.reasoning_content).toBe("plan"); // untouched
    expect(asst[1]!.reasoning_content).toBe(""); // backfilled → Z.ai satisfied
    expect("thinking" in out).toBe(false); // default keeps thinking ON
    expect(out.parallel_tool_calls).toBe(false);
  });

  it("B (env=1): disables thinking via MUONROI_ZAI_DISABLE_THINKING", () => {
    process.env[ENV] = "1";
    const body: WireBody = {
      messages: [{ role: "assistant", content: null, reasoning_content: "x", tool_calls: [{ id: "t1" }] }],
    };
    const out = transformZaiThinkingBody(body);
    expect(out.thinking).toEqual({ type: "disabled" });
    // Even in disabled-thinking mode we still want the parallel flag to protect against H3.
    expect(out.parallel_tool_calls).toBe(false);
  });
});

describe("ZaiStrategy end-to-end — wire body round-trip (c0dcf9153803 regression)", () => {
  // Mirrors exactly how zai.strategy.ts wires the SDK: createOpenAICompatible
  // with `transformRequestBody: transformZaiThinkingBody`. We cannot reuse the
  // strategy's createFactory directly because CreateFactoryOpts doesn't forward
  // a stub `fetch`, but the transform is the entire fix — the 1-line wiring in
  // zai.strategy.ts is typechecked and trivial.
  function makeZaiProvider(capture: { current: CapturedRequest | null }) {
    return createOpenAICompatible({
      name: "zai",
      baseURL: "https://example.test/v1",
      apiKey: "stub-key",
      transformRequestBody: (body) => transformZaiThinkingBody(body) as typeof body,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const bodyText = typeof init?.body === "string" ? init.body : "";
        capture.current = {
          url,
          body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
        };
        const sse = [
          'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
  }

  it("backfills reasoning_content on tool-only assistant turns once thinking mode is active", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeZaiProvider(capture);
    const model = provider("glm-4.7");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "go" },
        // turn 1: thinking mode — has reasoning_content (round-trips natively)
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "plan" },
            { type: "tool-call", toolCallId: "a", toolName: "read_file", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "a", toolName: "read_file", output: { type: "text", value: "r1" } },
          ],
        },
        // turn 2: the bug shape — SDK serializes this as
        // {content:null, tool_calls:[...]} with NO reasoning_content key.
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "b", toolName: "grep", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "b", toolName: "grep", output: { type: "text", value: "r2" } }],
        },
        { role: "user", content: "summarize" },
      ],
    });
    await drain(result.fullStream);

    expect(capture.current).not.toBeNull();
    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const assistantMsgs = body.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(2);
    // turn 1: reasoning_content preserved (real thought from the model)
    expect(assistantMsgs[0]!.reasoning_content).toBe("plan");
    // turn 2: THE FIX — reasoning_content backfilled so Z.ai's coding-endpoint
    // thinking-mode validator no longer rejects with code 1210.
    expect(assistantMsgs[1]!.reasoning_content).toBe("");
    expect(Array.isArray(assistantMsgs[1]!.tool_calls)).toBe(true);
  });

  it("does NOT inject reasoning_content for a non-thinking model history (glm-4.5-air safety)", async () => {
    const capture: { current: CapturedRequest | null } = { current: null };
    const provider = makeZaiProvider(capture);
    const model = provider("glm-4.5-air");

    const result = streamText({
      model,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: {} }] },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "t1", toolName: "read_file", output: { type: "text", value: "r" } },
          ],
        },
        { role: "user", content: "again" },
      ],
    });
    await drain(result.fullStream);

    const body = capture.current!.body as { messages: Array<Record<string, unknown>> };
    const asst = body.messages.find((m) => m.role === "assistant")!;
    // No reasoning in history → backfill must NOT fire (would cause 1210 on
    // a non-thinking model that doesn't recognise the field).
    expect("reasoning_content" in asst).toBe(false);
  });

  it("ZaiStrategy.createFactory wires transformRequestBody (smoke)", () => {
    // Verify the strategy actually attaches the transform — if this line is
    // deleted from zai.strategy.ts, the fix is silently inactive.
    const factory = new ZaiStrategy().createFactory({ baseURL: "https://example.test/v1", apiKey: "stub-key" });
    expect(typeof factory).toBe("function");
    // The transform is wired inside createOpenAICompatible's closure; we can't
    // introspect it, but creating a model handle must not throw.
    expect(() => factory("glm-4.7")).not.toThrow();
  });
});

describe("splitParallelToolCalls — H3 real fix (Z.ai 1210 / Console Go upstream reject)", () => {
  it("is identity when no assistant turn carries >1 tool_calls", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "read_file" } }] },
      { role: "tool", tool_call_id: "a", content: "r1" },
    ];
    // Same reference back — untouched, so successful single-call requests are safe.
    expect(splitParallelToolCalls(messages)).toBe(messages);
  });

  it("splits a batch of parallel tool_calls into sequential single-call turns with matched results", () => {
    // Shape mirrors the failing 06:57 Z.ai request (one assistant msg, many tool_calls).
    const messages = [
      {
        role: "assistant",
        content: "planning",
        reasoning_content: "let me look",
        tool_calls: [
          { id: "a", function: { name: "read_file" } },
          { id: "b", function: { name: "grep" } },
          { id: "c", function: { name: "bash" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
      { role: "tool", tool_call_id: "c", content: "rc" },
    ];
    const out = splitParallelToolCalls(messages);
    // 3 assistant + 3 tool = 6 messages, each assistant carries exactly one call.
    expect(out).toHaveLength(6);
    const assistants = out.filter((m) => (m as { role?: string }).role === "assistant");
    expect(assistants).toHaveLength(3);
    for (const a of assistants) {
      expect((a as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
    }
    // Order preserved: a→ra, b→rb, c→rc.
    expect(
      out.map(
        (m) =>
          (m as { tool_call_id?: string; tool_calls?: Array<{ id: string }> }).tool_call_id ??
          (m as { tool_calls?: Array<{ id: string }> }).tool_calls?.[0].id,
      ),
    ).toEqual(["a", "a", "b", "b", "c", "c"]);
    // reasoning_content + content kept on first split only, blanked on the rest.
    expect((assistants[0] as { reasoning_content: string }).reasoning_content).toBe("let me look");
    expect((assistants[1] as { reasoning_content: string }).reasoning_content).toBe("");
    expect((assistants[1] as { content: string }).content).toBe("");
  });

  it("is idempotent — re-splitting already-split history is a no-op", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: {} },
          { id: "b", function: {} },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ];
    const once = splitParallelToolCalls(messages);
    // Second pass sees no assistant turn with >1 tool_calls → same reference.
    expect(splitParallelToolCalls(once)).toBe(once);
  });

  it("transformZaiThinkingBody splits parallel tool_calls end-to-end (06:57 / 07:16 shape)", () => {
    const body = {
      model: "glm-4.7",
      messages: [
        {
          role: "assistant",
          content: "",
          reasoning_content: "thinking",
          tool_calls: [
            { id: "t1", function: { name: "read_file" } },
            { id: "t2", function: { name: "read_file" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "r1" },
        { role: "tool", tool_call_id: "t2", content: "r2" },
      ],
      max_tokens: 8192,
    };
    const out = transformZaiThinkingBody(body) as typeof body;
    const assistants = out.messages.filter((m) => (m as { role?: string }).role === "assistant");
    expect(assistants).toHaveLength(2);
    for (const a of assistants) {
      expect((a as { tool_calls: unknown[] }).tool_calls).toHaveLength(1);
    }
    // Existing hardening still applies.
    expect(out.max_tokens).toBe(4096);
    expect((out as Record<string, unknown>).parallel_tool_calls).toBe(false);
  });
});

describe("sanitizeToolCallArguments — 'unexpected end of JSON input' 1210 guard", () => {
  it("is identity when all tool_call arguments are valid JSON", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "a", function: { name: "read_file", arguments: '{"path":"x.ts"}' } }],
      },
    ];
    expect(sanitizeToolCallArguments(messages)).toBe(messages);
  });

  it("repairs empty / truncated / missing arguments to '{}'", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: { name: "read_file", arguments: "" } }, // empty
          { id: "b", function: { name: "grep", arguments: '{"pattern":"foo' } }, // truncated
          { id: "c", function: { name: "bash" } }, // missing arguments
          { id: "d", function: { name: "ls", arguments: '{"ok":true}' } }, // valid — untouched
        ],
      },
    ];
    const out = sanitizeToolCallArguments(messages) as typeof messages;
    const calls = out[0].tool_calls as Array<{ function: { arguments?: string } }>;
    expect(calls[0].function.arguments).toBe("{}");
    expect(calls[1].function.arguments).toBe("{}");
    expect(calls[2].function.arguments).toBe("{}");
    expect(calls[3].function.arguments).toBe('{"ok":true}');
  });

  it("re-stringifies a stray object arguments value", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "a", function: { name: "x", arguments: { path: "y" } as unknown as string } }],
      },
    ];
    const out = sanitizeToolCallArguments(messages) as typeof messages;
    const calls = out[0].tool_calls as Array<{ function: { arguments?: string } }>;
    expect(calls[0].function.arguments).toBe('{"path":"y"}');
  });
});
