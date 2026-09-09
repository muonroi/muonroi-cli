/**
 * src/orchestrator/mcp-tool-result-payload.test.ts
 *
 * Pins the defect measured on 2026-09-09: an agent driving MCP tools could not
 * read any tool result it had just received.
 *
 * Two instruments agreed in production and both are pinned here:
 *   1. the model-facing prompt — `bySegment.toolResults` on the `call_accounting`
 *      row of the call made right after `tui.capabilities` returned read 132
 *      chars against a 7,032-char payload;
 *   2. the UI/DB view — every MCP `interaction_logs` row read
 *      `{"success":true,"outputPreview":"[object Object]"}`.
 *
 * Collapse point (1): `attachReminderToMessages` (scope-reminder.ts) rewrote the
 * last tool-result part as `{type:"text", value: oldValue + reminder}` where
 * `oldValue` was `""` for any output whose `.value` is not a string. Every MCP
 * result is `{type:"content", value:[...]}` — an ARRAY — so the whole payload was
 * replaced by the reminder on the very step the model needed it.
 *
 * Collapse point (2): `toToolResult` fell to `String(output)` for the raw MCP
 * `CallToolResult` (`{content:[...], isError}`), which has no `success` key.
 *
 * Why this file does not just unit-test the helper: the same fix was aimed past
 * the cause before. The tool here is produced by the REAL `@ai-sdk/mcp` client
 * (over an in-memory transport, no subprocess), so it carries the REAL
 * `mcpToModelOutput`; it is driven by a REAL `streamText` loop; the prepareStep
 * glue is the same two calls `tool-engine.ts` makes (`buildConvergenceMirror` →
 * `attachReminderToMessages`); and the assertion is the REAL `analyzePrompt`
 * from the metered gate — the exact function that produced the 132 in the
 * evidence. Nothing about the payload shape is hand-written.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { stepCountIs, streamText } from "ai";
import { beforeAll, describe, expect, it } from "vitest";

import { installMockModel } from "../agent-harness/mock-model.js";
import { analyzePrompt } from "../providers/model-gate.js";
import { buildConvergenceMirror } from "./convergence-mirror.js";
import { attachReminderToMessages } from "./scope-reminder.js";
import { toToolResult } from "./tool-utils.js";

const TOOL_NAME = "probe_capabilities";
/** Stand-in for the 7,032-char `tui.capabilities` payload. */
const PAYLOAD = `{"protocol":"0.4.0","features":[${'"cap",'.repeat(900)}"last"]}`;

// ─────────────────────────────────────────────────────────────────────────────
// A real @ai-sdk/mcp client over an in-memory transport. This is the only way
// to get the SDK's real `mcpToModelOutput` (it is module-internal, not exported)
// without spawning a server.
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

class InMemoryMcpTransport {
  onmessage?: (message: JsonRpc) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;

  async start(): Promise<void> {
    /* nothing to connect — the "server" is the switch in send() */
  }

  async send(message: JsonRpc): Promise<void> {
    // Notifications carry no id and expect no reply.
    if (message.id === undefined) return;
    const reply = (result: unknown): void => {
      queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      reply({
        protocolVersion: (message.params as { protocolVersion?: string } | undefined)?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "in-memory-probe", version: "1.0.0" },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply({
        tools: [
          {
            name: TOOL_NAME,
            description: "Returns a large text payload, like tui.capabilities does.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    if (message.method === "tools/call") {
      // Exactly what an MCP server returns: a CallToolResult, no `success` key.
      reply({ content: [{ type: "text", text: PAYLOAD }], isError: false });
      return;
    }
    this.onerror?.(new Error(`[mcp-tool-result-payload.test] unhandled MCP method: ${message.method}`));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function toolCallChunks(id: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: TOOL_NAME, input: "{}" },
    {
      type: "finish",
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
    },
  ];
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "done" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

/**
 * Every character of every tool-result part in a recorded provider prompt,
 * concatenated — i.e. what the provider will put in its `tool` messages. Reads
 * the same `output` field `analyzePrompt` meters, so the two assertions in the
 * spec below cannot disagree about which bytes reached the model.
 */
function renderedToolText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const out: string[] = [];
  for (const msg of prompt as Array<{ content?: unknown }>) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content as Array<{ type?: string; output?: { value?: unknown } }>) {
      if (part?.type !== "tool-result") continue;
      const value = part.output?.value;
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) {
        for (const p of value as Array<{ text?: unknown }>) if (typeof p?.text === "string") out.push(p.text);
      } else out.push(JSON.stringify(value) ?? "");
    }
  }
  return out.join("\n");
}

describe("MCP tool result reaches the model (and the UI)", () => {
  let mcpTools: ToolSet;
  let rawMcpResult: unknown;

  beforeAll(async () => {
    const { experimental_createMCPClient } = await import("@ai-sdk/mcp");
    const client = await experimental_createMCPClient({ transport: new InMemoryMcpTransport() as never });
    mcpTools = (await client.tools()) as unknown as ToolSet;
    const execute = (mcpTools[TOOL_NAME] as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> })
      .execute;
    rawMcpResult = await execute({}, { toolCallId: "probe", messages: [] });
  });

  it("gives the model the payload on the step right after the tool ran", async () => {
    const handle = installMockModel({
      fixture: { stream: [toolCallChunks("c1"), finalTextChunks()] },
    });
    try {
      const result = streamText({
        model: handle.model,
        system: "You drive tools.",
        messages: [{ role: "user", content: "call the probe tool" }],
        tools: mcpTools,
        stopWhen: stepCountIs(4),
        maxRetries: 0,
        // The same two calls tool-engine.ts makes inside its own prepareStep:
        // compute the convergence mirror from the raw stepMessages, then attach
        // it through the tool_result channel.
        prepareStep: ({ messages, stepNumber }) => {
          const note = buildConvergenceMirror(messages as never, { stepNumber });
          if (!note) return undefined;
          return { messages: attachReminderToMessages(messages, note) as typeof messages };
        },
      });
      for await (const _ of result.textStream) {
        /* drain */
      }

      // calls[0] is the pre-tool call; calls[1] is the one carrying the result.
      expect(handle.calls.length).toBeGreaterThanOrEqual(2);
      const post = handle.calls[1]!;
      const composition = analyzePrompt((post as { prompt?: unknown }).prompt);

      // The reminder DID fire on this step — otherwise the assertion below would
      // pass for the wrong reason (nothing to destroy).
      const rendered = renderedToolText((post as { prompt?: unknown }).prompt);
      expect(rendered).toContain("mirror");

      // The whole point: the payload is still there, alongside the reminder.
      expect(rendered).toContain(PAYLOAD);
      expect(composition.bySegment.toolResults).toBeGreaterThanOrEqual(PAYLOAD.length);
    } finally {
      handle.uninstall();
    }
  });

  it("renders the MCP result for the UI/DB instead of [object Object]", () => {
    const tr = toToolResult(rawMcpResult);
    expect(tr.output).not.toBe("[object Object]");
    expect(tr.output).toContain(PAYLOAD.slice(0, 200));
    expect(tr.success).toBe(true);
  });

  it("reports an MCP isError result as a failure, with its text", () => {
    const tr = toToolResult({ content: [{ type: "text", text: '{"error":"argv_rejected"}' }], isError: true });
    expect(tr.success).toBe(false);
    expect(tr.output).toContain("argv_rejected");
    expect(tr.error).toContain("argv_rejected");
  });
});
