/**
 * enforceCompactionBudget — the deterministic size guarantee behind
 * compactForContext. Evidence (session c2fda568be6b, 2026-11-06): 41
 * compactions, nearly all "saved 0", because turns retained by a protection
 * (`outstanding-job` 829,813 tokens, `user-pin-or-folded-policy` 189,127) kept
 * their full payload. Replayed offline on that transcript: 988,388 -> 306,736
 * est tokens at level 1 (232 tool results stubbed, 194 reasoning parts dropped).
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { estimateConversationTokens } from "../compaction.js";
import { enforceCompactionBudget, HOST_COMPACTION_STUB_PREFIX } from "../compaction-budget.js";

const big = (tag: string, n = 4_000) => `${tag} ${"payload ".repeat(n / 8)}`;

function turn(i: number): ModelMessage[] {
  return [
    { role: "user", content: `USER_${i} keep me verbatim` },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: big(`REASONING_${i}`) },
        { type: "text", text: `ANSWER_${i}` },
        { type: "tool-call", toolCallId: `call_${i}`, toolName: "read_file", input: { path: `f${i}.ts` } },
      ],
    } as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${i}`,
          toolName: "read_file",
          output: { type: "text", value: big(`RESULT_${i}`) },
        },
      ],
    } as ModelMessage,
  ];
}

function history(turns: number): ModelMessage[] {
  const head: ModelMessage = { role: "system", content: `[Context checkpoint summary]\nSUMMARY ${"s".repeat(3_000)}` };
  const notice: ModelMessage = { role: "system", content: big("Background agent complete: `job-1`", 9_000) };
  const out: ModelMessage[] = [head, notice];
  for (let i = 0; i < turns; i++) out.push(...turn(i));
  out.push({ role: "user", content: `CURRENT ${"c".repeat(5_000)}` });
  return out;
}

const tokens = (ms: ModelMessage[]) => estimateConversationTokens("sys", ms);
const text = (ms: ModelMessage[]) => JSON.stringify(ms);

describe("enforceCompactionBudget", () => {
  it("returns the input by identity when it already fits", () => {
    const ms = history(2);
    const r = enforceCompactionBudget(ms, {
      systemPrompt: "sys",
      softBudgetTokens: tokens(ms) + 1,
      hardBudgetTokens: 0,
      headCount: 1,
      tail: new Set(),
    });
    expect(r.level).toBe(0);
    expect(r.messages).toBe(ms);
  });

  it("level 1 shrinks protection-retained turns, keeps pairing, ids, user text, head and the current turn", () => {
    const ms = history(6);
    const tail = new Set(ms.slice(-4)); // last full turn + current user message
    const persisted: string[] = [];
    const r = enforceCompactionBudget(ms, {
      systemPrompt: "sys",
      softBudgetTokens: 1_000,
      hardBudgetTokens: 0,
      headCount: 1,
      tail,
      persistArtifact: (id) => persisted.push(id),
    });
    expect(r.level).toBe(1);
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore / 2);
    expect(r.messages).toHaveLength(ms.length); // nothing dropped
    expect(r.messages[0]).toBe(ms[0]); // head untouched
    expect(r.messages.at(-1)).toBe(ms.at(-1)); // current turn untouched
    const out = text(r.messages);
    // Stubbed outputs name the exact id retrieve_tool_result needs; full text was recorded.
    expect(out).toContain(`${HOST_COMPACTION_STUB_PREFIX} read_file result`);
    expect(out).toContain('retrieve_tool_result({\\"tool_call_id\\":\\"call_0\\"})');
    expect(persisted).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4"]);
    expect(out).not.toContain("REASONING_0");
    expect(out).toContain("REASONING_5"); // verbatim tail keeps its reasoning at level 1
    for (let i = 0; i < 6; i++) {
      expect(out).toContain(`USER_${i} keep me verbatim`);
      expect(out).toContain(`"toolCallId":"call_${i}"`);
    }
    expect(r.truncatedTexts).toBe(1); // the 9k background notice
    expect(r.droppedMessages).toBe(0);
  });

  it("is idempotent on already-stubbed output (a second compaction does not re-stub)", () => {
    const ms = history(4);
    const opts = {
      systemPrompt: "sys",
      softBudgetTokens: 500,
      hardBudgetTokens: 0,
      headCount: 1,
      tail: new Set<ModelMessage>(),
    };
    const once = enforceCompactionBudget(ms, opts);
    const twice = enforceCompactionBudget(once.messages, opts);
    expect(twice.stubbedToolResults).toBe(0);
    expect(text(twice.messages)).toBe(text(once.messages));
  });

  it("levels 2-3 drop whole oldest turns under hard pressure without orphaning a tool result", () => {
    const ms = history(8);
    // A background job: call made in turn 0, result delivered after turn 1's user message.
    const lateResult: ModelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_0", toolName: "read_file", output: { type: "text", value: "late" } },
      ],
    } as ModelMessage;
    ms.splice(6, 0, lateResult);
    const r = enforceCompactionBudget(ms, {
      systemPrompt: "sys",
      softBudgetTokens: 200,
      hardBudgetTokens: 1_500,
      headCount: 1,
      tail: new Set(),
    });
    expect(r.level).toBe(3);
    expect(r.droppedMessages).toBeGreaterThan(0);
    expect(r.messages[0]).toBe(ms[0]);
    expect(r.messages.at(-1)).toBe(ms.at(-1));
    const callIds = new Set<string>();
    for (const m of r.messages)
      if (m.role === "assistant" && Array.isArray(m.content))
        for (const p of m.content as Array<{ type: string; toolCallId?: string }>)
          if (p.type === "tool-call") callIds.add(p.toolCallId!);
    for (const m of r.messages)
      if (m.role === "tool")
        for (const p of m.content as Array<{ type: string; toolCallId?: string }>)
          expect(callIds.has(p.toolCallId!)).toBe(true);
    // sourceIndices map every survivor back to its input slot, in order.
    expect(r.sourceIndices).toEqual([...r.sourceIndices].sort((a, b) => a - b));
    expect(r.sourceIndices[0]).toBe(0);
    expect(r.sourceIndices.at(-1)).toBe(ms.length - 1);
  });

  it("level 3 never drops a turn holding a neverDrop message", () => {
    const ms = history(6);
    const pinned = ms[2]!; // USER_0
    const r = enforceCompactionBudget(ms, {
      systemPrompt: "sys",
      softBudgetTokens: 100,
      hardBudgetTokens: 400,
      headCount: 1,
      tail: new Set(),
      neverDrop: new Set([pinned]),
    });
    expect(r.messages).toContain(ms[2]);
  });
});
