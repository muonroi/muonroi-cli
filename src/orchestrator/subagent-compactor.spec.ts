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

  it("returns the SAME array reference on a no-op below threshold (compacted===input contract)", () => {
    // Callers (message-processor B4 prepareStep:1840/1908/1914) detect "did NOT
    // compact this step" via `compacted === stripped`. The docstring promises the
    // original ref on a no-op; returning a fresh slice silently broke that —
    // making the pre-compaction warning dead and the compaction note fire every
    // step. Lock the identity contract.
    const msgs = buildHistory(2, 5); // below threshold
    expect(compactSubAgentMessages(msgs)).toBe(msgs);
  });

  it("returns a NEW array when compaction actually elides (compacted!==input)", () => {
    const msgs = buildHistory(10, 10); // ~100kb > threshold
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool"; // force low-value so it elides
      }
    }
    expect(compactSubAgentMessages(msgs)).not.toBe(msgs);
  });

  it("compacts when cumulative chars exceed threshold", () => {
    const msgs = buildHistory(10, 10); // ~100kb of tool output
    // Neutralize to test pure size-based elision (high-value keep would reduce savings).
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
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

  it("keeps an OLDER authoritative muonroi-docs MCP result verbatim while eliding low-value peers (session 584ba476c07a)", () => {
    // History: an early muonroi-docs setup_guide (older than keepLast=3) + many
    // low-value tool turns. The ecosystem doc must survive compaction so the
    // agent stays grounded on the source it was nudged to fetch first.
    const docsValue = bigText("ECOSYSTEM_DOCS", 6); // ~6kb authoritative payload
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are the agent." },
      { role: "user", content: "ecosystem question" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_docs",
            toolName: "mcp_muonroi-docs__setup_guide",
            input: JSON.stringify({ component: "ecosystem" }),
          },
        ],
      } as unknown as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_docs",
            toolName: "mcp_muonroi-docs__setup_guide",
            output: { type: "text", value: docsValue },
          },
        ],
      } as unknown as ModelMessage,
    ];
    // Pile on low-value turns to push well past threshold and make the docs turn "old".
    for (let i = 1; i <= 10; i++) {
      const t = toolTurn(i, 10);
      (t[1] as any).content[0].toolName = "mcp_filesystem__list_directory"; // low-value MCP
      (t[0] as any).content[0].toolName = "mcp_filesystem__list_directory";
      msgs.push(...t);
    }

    const out = compactSubAgentMessages(msgs);
    expect(out).not.toBe(msgs); // compaction fired

    // The muonroi-docs result is kept verbatim (full payload, no stub).
    const docsMsg = out.find(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        (m.content as any)[0]?.toolName === "mcp_muonroi-docs__setup_guide",
    );
    const docsOut = (docsMsg?.content as any)[0].output.value as string;
    expect(docsOut).toBe(docsValue);
    expect(docsOut).not.toMatch(/elided by/);

    // A low-value filesystem MCP peer from an OLD turn IS stubbed.
    const stubbed = out.some(
      (m) =>
        m.role === "tool" &&
        Array.isArray(m.content) &&
        typeof (m.content as any)[0]?.output?.value === "string" &&
        (m.content as any)[0].output.value.includes("elided by"),
    );
    expect(stubbed).toBe(true);
  });

  it("rewrites older tool-result parts with elision stub", () => {
    const msgs = buildHistory(10, 10);
    // Neutralize tool so the basic elision test is not affected by high-value auto-keep (idea 1).
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
    const out = compactSubAgentMessages(msgs);
    // First tool message is at index 3 (system, user, asst, tool, ...).
    const firstToolMsg = out[3]!;
    expect(firstToolMsg.role).toBe("tool");
    const parts = firstToolMsg.content as unknown as ReadonlyArray<Record<string, unknown>>;
    const tr = parts[0] as { type: string; output: { type: string; value: string } };
    expect(tr.type).toBe("tool-result");
    expect(tr.output.value).toMatch(/earlier tool_result for tool=other_tool/);
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
    // Neutralize so high-value (idea 1) does not override keep=0 for this test's intent.
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
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
    const withEnvInput = buildHistory(10, 5);
    for (const m of withEnvInput) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
    const withEnv = compactSubAgentMessages(withEnvInput, {
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

  // F1 (revised, A3 cache-stability) — compaction is IDEMPOTENT.
  //
  // Previously a second pass super-shrank existing stubs further, mutating
  // their content every round. In the agentic loop the compactor runs once
  // per streamText call, so an already-stubbed message changed bytes on every
  // call → the OpenAI prompt-cache prefix churned (forensics: 0% cache hit on
  // calls 1-4, only stabilising by call 5). Terminal stubs let the prefix
  // cache from call 2. The marginal extra shrink is not worth the cache loss.
  it("is idempotent (fixed point) — compacting twice equals once, keeping the cached prefix stable", () => {
    const msgs = buildHistory(12, 10);
    const once = compactSubAgentMessages(msgs);
    const twice = compactSubAgentMessages(once);
    expect(twice).toEqual(once);
  });

  it("does NOT rewrite an already-written stub on re-compaction (terminal stubs)", () => {
    const msgs = buildHistory(12, 10);
    const firstPass = compactSubAgentMessages(msgs);
    const total = cumulativeMessageChars(firstPass);
    // Force another pass with a lower threshold; existing stubs must be byte-identical.
    const secondPass = compactSubAgentMessages(firstPass, { thresholdChars: Math.floor(total / 2) });
    const stubsOf = (arr: ReadonlyArray<{ role: string; content: unknown }>): string[] =>
      arr
        .flatMap((m) =>
          Array.isArray(m.content)
            ? (m.content as ReadonlyArray<Record<string, unknown>>)
                .filter((p) => p.type === "tool-result")
                .map((p) => (p as { output?: { value?: string } }).output?.value)
            : [],
        )
        .filter((v): v is string => typeof v === "string" && /elided by sub-agent compactor/.test(v));
    // Every stub the first pass produced is present, byte-identical, after re-compaction.
    for (const s of stubsOf(firstPass)) {
      expect(stubsOf(secondPass)).toContain(s);
    }
  });

  // G1 — context-window-aware threshold
  it("contextWindowTokens overrides char threshold to fire earlier (G1)", () => {
    // 8K window × 0.5 ratio × 4 chars/token = 16K char budget.
    // Build 30K of messages — char-threshold 80K would NOT fire, but the
    // tiny window MUST trigger compaction.
    const msgs = buildHistory(6, 5); // ~30K chars
    // Neutral tool name so high-value heuristic (idea 1) does not force-keep everything.
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
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
    // Neutral tool so high-value (idea 1) does not interfere with dynamic keepLast count.
    for (const m of msgs) {
      if (m.role === "tool" && Array.isArray(m.content)) {
        (m.content as any)[0].toolName = "other_tool";
      }
    }
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

  // Idea 1: high-value tool results kept verbatim even when older than keepLast
  it("keeps high-value tool results (read_file/grep on src + error/PLAN) verbatim (idea 1)", () => {
    const msgs = buildHistory(8, 4);
    // Force a high-value marker in an early turn (index ~3-4)
    const earlyTool = msgs[3] as any;
    if (earlyTool?.content?.[0]) {
      earlyTool.content[0].output = { type: "text", value: "PLAN.md\nsrc/index.ts\nerror: critical" };
    }
    const out = compactSubAgentMessages(msgs, { thresholdChars: 10_000, keepLastTurns: 2 });
    // The early high-value one should not be stubbed.
    const earlyOut = out[3] as any;
    const val = earlyOut?.content?.[0]?.output?.value || "";
    expect(val).not.toMatch(/elided by .* compactor/);
  });

  // Idea 3: explicit keepToolIds bypasses elision
  it("respects keepToolIds (idea 3) — specific ids kept even if old", () => {
    const msgs = buildHistory(6, 5);
    const targetId = "call_2"; // early turn
    const out = compactSubAgentMessages(msgs, {
      thresholdChars: 10_000,
      keepLastTurns: 1,
      keepToolIds: [targetId],
    });
    let keptExplicit = false;
    for (const m of out) {
      if (m.role !== "tool" || !Array.isArray(m.content)) continue;
      const tr = (m.content as any)[0];
      if (tr?.toolCallId === targetId && typeof tr.output?.value === "string" && !/elided/.test(tr.output.value)) {
        keptExplicit = true;
      }
    }
    expect(keptExplicit).toBe(true);
  });
});
