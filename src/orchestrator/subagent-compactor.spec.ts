/**
 * Unit spec for src/orchestrator/subagent-compactor.ts (Phase B3).
 */
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { compactSubAgentMessages, cumulativeMessageChars } from "./subagent-compactor.js";

function bigText(label: string, kb: number): string {
  const block = `${label}:${"x".repeat(kb * 1000)}`;
  return block;
}

function toolTurn(idx: number, kb: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call_${idx}`,
          toolName: "read_file",
          input: JSON.stringify({ path: `/tmp/f${idx}.txt` }),
        },
      ],
    } as unknown as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${idx}`,
          toolName: "read_file",
          output: { type: "text", value: bigText(`R${idx}`, kb) },
        },
      ],
    } as unknown as ModelMessage,
  ];
}

function buildHistory(turns: number, kbPerTurn: number): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "system", content: "You are the Explore sub-agent. You are read-only." },
    { role: "user", content: "research auth wiring" },
  ];
  for (let i = 1; i <= turns; i++) msgs.push(...toolTurn(i, kbPerTurn));
  return msgs;
}

describe("subagent-compactor: cumulativeMessageChars", () => {
  it("sums tool_result output JSON length", () => {
    const m = buildHistory(2, 10); // ~20kb of tool output
    expect(cumulativeMessageChars(m)).toBeGreaterThan(20_000);
  });
});

describe("subagent-compactor: compactSubAgentMessages", () => {
  const ENV_KEYS = ["MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS", "MUONROI_SUBAGENT_COMPACT_KEEP_LAST"] as const;
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
      delete saved[k];
    }
  });

  it("passes through small message arrays unchanged in shape", () => {
    const msgs = buildHistory(2, 5); // ~10kb < 80kb default threshold
    const out = compactSubAgentMessages(msgs);
    expect(out.length).toBe(msgs.length);
    // No tool-result rewrite happened — output object identity per part preserved.
    expect(out[3]).toBe(msgs[3]);
  });

  it("compacts when cumulative chars exceed threshold", () => {
    const msgs = buildHistory(10, 10); // ~100kb of tool output
    const before = cumulativeMessageChars(msgs);
    const out = compactSubAgentMessages(msgs);
    const after = cumulativeMessageChars(out);
    expect(before).toBeGreaterThan(80_000);
    expect(after).toBeLessThan(before / 2);
  });

  it("preserves system + first user message verbatim", () => {
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs);
    expect(out[0]).toBe(msgs[0]); // system
    expect(out[1]).toBe(msgs[1]); // first user
  });

  it("preserves last N tool turns verbatim (default 3)", () => {
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs);
    // Last 3 turns = 6 messages; verify the trailing slice is referentially equal.
    for (let i = 1; i <= 6; i++) {
      expect(out[out.length - i]).toBe(msgs[msgs.length - i]);
    }
  });

  it("rewrites older tool-result parts with elision stub", () => {
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs);
    // First tool message is at index 3 (system, user, asst, tool, ...).
    const firstToolMsg = out[3]!;
    expect(firstToolMsg.role).toBe("tool");
    const parts = firstToolMsg.content as unknown as ReadonlyArray<Record<string, unknown>>;
    const tr = parts[0] as { type: string; output: { type: string; value: string } };
    expect(tr.type).toBe("tool-result");
    expect(tr.output.value).toMatch(/earlier tool_result for tool=read_file/);
    expect(tr.output.value).toMatch(/elided by sub-agent compactor/);
  });

  it("respects custom threshold (no compaction when threshold raised)", () => {
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs, { thresholdChars: 500_000 });
    // No rewrite — every tool result still references the original object.
    for (let i = 3; i < msgs.length; i++) {
      if (msgs[i]?.role === "tool") {
        expect(out[i]).toBe(msgs[i]);
      }
    }
  });

  it("keepLastTurns=0 compacts every tool turn (no trailing window preserved)", () => {
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs, { keepLastTurns: 0 });
    // Every tool message in the output is a compacted stub.
    for (let i = 0; i < out.length; i++) {
      if (out[i]?.role !== "tool") continue;
      const parts = out[i]!.content as unknown as ReadonlyArray<Record<string, unknown>>;
      const tr = parts[0] as { output: { value: string } };
      expect(tr.output.value).toMatch(/sub-agent compactor/);
    }
  });

  it("env override raises threshold → no compaction", () => {
    // The compactor itself doesn't read env (settings.ts does), but verify the
    // option pipeline does what callers expect.
    const msgs = buildHistory(10, 10);
    const out = compactSubAgentMessages(msgs, { thresholdChars: 1_000_000 });
    expect(cumulativeMessageChars(out)).toBe(cumulativeMessageChars(msgs));
  });

  // F2 — envelope counted in threshold
  it("envelopeChars contributes to threshold check (F2)", () => {
    const msgs = buildHistory(2, 5); // only ~10kb of messages
    // Without envelope: well below 80K → no compaction.
    const noEnv = compactSubAgentMessages(msgs);
    expect(cumulativeMessageChars(noEnv)).toBe(cumulativeMessageChars(msgs));
    // With 100K envelope: total > 80K → compactor fires (but only 2 turns
    // means everything is in the keep window, so still no-op).
    const withEnv = compactSubAgentMessages(buildHistory(10, 5), {
      thresholdChars: 80_000,
      envelopeChars: 100_000,
    });
    // 10 turns × 5kb ≈ 50K + 100K envelope = 150K → fires; older stubs land.
    let foundStub = false;
    for (const m of withEnv) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const p of m.content as ReadonlyArray<Record<string, unknown>>) {
        if (p.type !== "tool-result") continue;
        const o = (p as { output?: { value?: string } }).output;
        if (typeof o?.value === "string" && /elided by sub-agent compactor/.test(o.value)) {
          foundStub = true;
        }
      }
    }
    expect(foundStub).toBe(true);
  });

  // F1 — re-compaction super-shrinks existing stubs
  it("super-shrinks already-stubbed tool_results on re-compaction (F1)", () => {
    const msgs = buildHistory(10, 10);
    const firstPass = compactSubAgentMessages(msgs);
    // Force re-compaction by lowering threshold below first-pass total.
    const total = cumulativeMessageChars(firstPass);
    const secondPass = compactSubAgentMessages(firstPass, { thresholdChars: Math.floor(total / 2) });
    // Second pass should be SHORTER than the first because stubs were
    // super-shrunk to "[elided <tool> (<label>)]".
    expect(cumulativeMessageChars(secondPass)).toBeLessThan(cumulativeMessageChars(firstPass));
    // Detect the super-shrunk marker (it's shorter than the original stub).
    let foundSuper = false;
    for (const m of secondPass) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const p of m.content as ReadonlyArray<Record<string, unknown>>) {
        if (p.type !== "tool-result") continue;
        const o = (p as { output?: { value?: string } }).output;
        if (typeof o?.value === "string" && /^\[elided read_file \(sub-agent\)\]$/.test(o.value)) {
          foundSuper = true;
        }
      }
    }
    expect(foundSuper).toBe(true);
  });

  // G1 — context-window-aware threshold
  it("contextWindowTokens overrides char threshold to fire earlier (G1)", () => {
    // 8K window × 0.5 ratio × 4 chars/token = 16K char budget.
    // Build 30K of messages — char-threshold 80K would NOT fire, but the
    // tiny window MUST trigger compaction.
    const msgs = buildHistory(6, 5); // ~30K chars
    const out = compactSubAgentMessages(msgs, {
      thresholdChars: 80_000, // would normally skip
      contextWindowTokens: 8_000,
      contextFillRatio: 0.5,
    });
    // Earlier tool results stubbed.
    let stubbed = 0;
    for (const m of out) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const p of m.content as ReadonlyArray<Record<string, unknown>>) {
        if (p.type !== "tool-result") continue;
        const o = (p as { output?: { value?: string } }).output;
        if (typeof o?.value === "string" && /elided by sub-agent compactor/.test(o.value)) {
          stubbed += 1;
        }
      }
    }
    expect(stubbed).toBeGreaterThan(0);
  });

  // G2 — dynamic keepLastTurns shrinks when context is near full
  it("shrinks keepLastTurns when context fill ≥ 80% (G2)", () => {
    // Window 8K, message+envelope chars ≈ 7K tokens × 4 = 28K → 0.875 fill.
    // keepLastTurns starts at 5; should drop to 1 → more turns get stubbed.
    const msgs = buildHistory(10, 3); // ~30K chars ≈ 7.5K tokens
    const out = compactSubAgentMessages(msgs, {
      thresholdChars: 10_000,
      keepLastTurns: 5,
      contextWindowTokens: 8_000,
      contextFillRatio: 0.3,
    });
    // Count NON-stubbed tool messages (these were kept verbatim).
    let kept = 0;
    for (const m of out) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const p of m.content as ReadonlyArray<Record<string, unknown>>) {
        if (p.type !== "tool-result") continue;
        const o = (p as { output?: { value?: string } }).output;
        if (typeof o?.value === "string" && !/elided/.test(o.value)) {
          kept += 1;
        }
      }
    }
    // Effective keepLast was 1 (not 5) → only 1 tool result kept verbatim.
    expect(kept).toBe(1);
  });
});
