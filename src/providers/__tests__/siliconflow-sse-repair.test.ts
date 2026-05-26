/**
 * Regression for SiliconFlow Qwen3-30B tool_call SSE malformation
 * observed in session 44db9105b119 (2026-05-26).
 *
 * Each block pins one behavior — repair, pass-through, or boundary
 * handling — so any future provider quirk surfaces as a focused
 * failure instead of a generic stream crash.
 */
import { describe, expect, it } from "vitest";
import { _internals, createSiliconflowRepairFetch } from "../siliconflow-sse-repair.js";

const { SiliconflowSseRepairer } = _internals;

function makeSseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseEventPayload(eventText: string): Record<string, unknown> | null {
  const m = eventText.match(/^data: (.+)$/m);
  if (!m) return null;
  if (m[1] === "[DONE]") return null;
  return JSON.parse(m[1] ?? "{}");
}

describe("SiliconflowSseRepairer.repairEvent", () => {
  it("passes through well-formed first chunk (id + name on chunk 1)", () => {
    const r = new SiliconflowSseRepairer();
    const ev = makeSseEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "grep", arguments: '{"a":' },
              },
            ],
          },
        },
      ],
    });
    const out = r.repairEvent(ev);
    const payload = parseEventPayload(out);
    const choice0 = (payload?.choices as Array<{ delta: { tool_calls: unknown[] } }> | undefined)?.[0];
    const tc0 = choice0?.delta.tool_calls?.[0] as Record<string, unknown> | undefined;
    expect(tc0?.id).toBe("call_abc");
    const fn = tc0?.function as Record<string, unknown> | undefined;
    expect(fn?.name).toBe("grep");
    expect(fn?.arguments).toBe('{"a":');
  });

  it("buffers a first chunk with no id+name, flushes when name arrives", () => {
    const r = new SiliconflowSseRepairer();
    const ev1 = makeSseEvent({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }],
          },
        },
      ],
    });
    expect(r.repairEvent(ev1)).toBe("");

    const ev2 = makeSseEvent({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_xyz",
                function: { name: "grep", arguments: '"catch"}' },
              },
            ],
          },
        },
      ],
    });
    const out = r.repairEvent(ev2);
    const payload = parseEventPayload(out);
    const tc0 = (payload?.choices as Array<{ delta: { tool_calls: unknown[] } }>)[0]?.delta.tool_calls?.[0] as Record<
      string,
      unknown
    >;
    expect(tc0.id).toBe("call_xyz");
    const fn = tc0.function as Record<string, unknown>;
    expect(fn.name).toBe("grep");
    expect(fn.arguments).toBe('{"pattern":"catch"}');
  });

  it("after flush, subsequent argument deltas pass through unchanged", () => {
    const r = new SiliconflowSseRepairer();
    r.repairEvent(
      makeSseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "x", arguments: '{"' } }],
            },
          },
        ],
      }),
    );
    const cont = makeSseEvent({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'k":1}' } }] } }],
    });
    const out = r.repairEvent(cont);
    const tc0 = (parseEventPayload(out)?.choices as Array<{ delta: { tool_calls: unknown[] } }>)[0]?.delta
      .tool_calls?.[0] as Record<string, unknown>;
    const fn = tc0.function as Record<string, unknown>;
    expect(fn.arguments).toBe('k":1}');
    expect(tc0.id).toBeUndefined();
  });

  it("handles multi-index streams independently", () => {
    const r = new SiliconflowSseRepairer();
    expect(
      r.repairEvent(
        makeSseEvent({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "{" } },
                  { index: 1, function: { arguments: "{" } },
                ],
              },
            },
          ],
        }),
      ),
    ).toBe("");

    const out = r.repairEvent(
      makeSseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c0", function: { name: "read_file", arguments: '"p":"a"}' } }],
            },
          },
        ],
      }),
    );
    const tcs = (parseEventPayload(out)?.choices as Array<{ delta: { tool_calls: unknown[] } }>)[0]?.delta
      .tool_calls as Array<Record<string, unknown>>;
    expect(tcs).toHaveLength(1);
    expect(tcs[0]?.id).toBe("c0");
    expect((tcs[0]?.function as Record<string, unknown>).arguments).toBe('{"p":"a"}');

    expect(
      r.repairEvent(
        makeSseEvent({
          choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"q"' } }] } }],
        }),
      ),
    ).toBe("");

    const out2 = r.repairEvent(
      makeSseEvent({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, id: "c1", function: { name: "grep", arguments: "}" } }],
            },
          },
        ],
      }),
    );
    const tcs2 = (parseEventPayload(out2)?.choices as Array<{ delta: { tool_calls: unknown[] } }>)[0]?.delta
      .tool_calls as Array<Record<string, unknown>>;
    expect(tcs2[0]?.id).toBe("c1");
    expect((tcs2[0]?.function as Record<string, unknown>).arguments).toBe('{"q"}');
  });

  it("preserves content-only deltas unchanged", () => {
    const r = new SiliconflowSseRepairer();
    const ev = makeSseEvent({ choices: [{ delta: { content: "hello" } }] });
    expect(r.repairEvent(ev)).toBe(ev);
  });

  it("preserves [DONE] sentinel", () => {
    const r = new SiliconflowSseRepairer();
    expect(r.repairEvent("data: [DONE]\n\n")).toBe("data: [DONE]\n\n");
  });

  it("preserves event with finish_reason even when tool_calls is suppressed", () => {
    const r = new SiliconflowSseRepairer();
    const ev = makeSseEvent({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: "{" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const out = r.repairEvent(ev);
    const payload = parseEventPayload(out);
    expect(payload).not.toBeNull();
    const choice0 = (payload?.choices as Array<Record<string, unknown>>)[0];
    expect(choice0?.finish_reason).toBe("tool_calls");
    expect((choice0?.delta as Record<string, unknown>).tool_calls).toBeUndefined();
  });

  it("returns input unchanged on un-parseable JSON payload", () => {
    const r = new SiliconflowSseRepairer();
    const ev = "data: not-json{\n\n";
    expect(r.repairEvent(ev)).toBe(ev);
  });

  it("returns input unchanged when no data: line present", () => {
    const r = new SiliconflowSseRepairer();
    const ev = ": heartbeat\n\n";
    expect(r.repairEvent(ev)).toBe(ev);
  });
});

describe("createSiliconflowRepairFetch", () => {
  function sseResponse(events: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const e of events) controller.enqueue(encoder.encode(e));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  async function readAll(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  it("repairs malformed first chunk in a real streaming response", async () => {
    const ev1 = makeSseEvent({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"k":' } }] } }],
    });
    const ev2 = makeSseEvent({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: '"v"}' } }],
          },
        },
      ],
    });
    const baseFetch: typeof fetch = async () => sseResponse([ev1, ev2, "data: [DONE]\n\n"]);
    const wrapped = createSiliconflowRepairFetch(baseFetch);
    const res = await wrapped("https://example.com/v1/chat/completions");
    const text = await readAll(res);
    expect(text).not.toContain('"arguments":"{\\"k\\":"');
    expect(text).toContain('"id":"c"');
    expect(text).toContain('"name":"f"');
    expect(text).toContain('"arguments":"{\\"k\\":\\"v\\"}"');
    expect(text).toContain("[DONE]");
  });

  it("passes through non-SSE responses unchanged", async () => {
    const baseFetch: typeof fetch = async () =>
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    const wrapped = createSiliconflowRepairFetch(baseFetch);
    const res = await wrapped("https://example.com/v1/models");
    const txt = await res.text();
    expect(txt).toBe('{"ok":true}');
  });

  it("handles events split across multiple reader chunks", async () => {
    const ev = makeSseEvent({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c", function: { name: "g", arguments: '"x"' } }],
          },
        },
      ],
    });
    const half = Math.floor(ev.length / 2);
    const baseFetch: typeof fetch = async () => sseResponse([ev.slice(0, half), ev.slice(half)]);
    const wrapped = createSiliconflowRepairFetch(baseFetch);
    const res = await wrapped("https://example.com/v1/chat/completions");
    const text = await readAll(res);
    expect(text).toContain('"id":"c"');
    expect(text).toContain('"name":"g"');
  });
});
