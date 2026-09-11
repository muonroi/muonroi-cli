/**
 * The dedup↔compaction trap, pinned.
 *
 * Measured live during an /ideal sprint (interaction_logs): an implementation
 * sub-agent issued ONE bash command nine times in a row, 5-7s apart, writing
 * nothing in between:
 *
 *   02:33:45 {"command":"find .../TcIs.CodeStandard.Analyzers.Tests -name \"*.cs\" | sort"}
 *   02:33:52 … 02:34:33  (identical argsPreview every time)
 *
 * Every one of the nine tool_result rows was 29 chars — our own cross-turn
 * dedup pointer ("[dup of … — reuse]"), and a `compact` tool call had run at
 * 02:30:26, three minutes earlier. The payload the pointer named was no longer
 * in the model's history. The model could not obtain the data and could not
 * stop asking: the pointer was unresolvable by construction.
 *
 * These tests drive the REAL wrapper composition (sub-agent cap → cross-turn
 * dedup, exactly as stream-runner.ts:377 and tool-engine.ts:1298 wire it) and
 * the REAL compaction primitives (`prepareCompaction` for the cross-turn drop,
 * `compactSubAgentMessages` for the in-loop prepareStep elision) rather than a
 * hand-built mock, because a builder-only test that never exercises the wrapper
 * pipeline is how the H5 defect survived in this repo.
 */

import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import { createCompactionSummaryMessage, prepareCompaction } from "../compaction.js";
import { CrossTurnDedup, wrapToolSetWithDedup } from "../cross-turn-dedup.js";
import { noteElidedForCap, type SubAgentCapState, wrapToolSetWithCap } from "../sub-agent-cap.js";
import { compactSubAgentMessages } from "../subagent-compactor.js";

/** The measured command — identical on all nine calls. */
const CMD = { command: 'find /d/sources/TcIs/TcIs.CodeStandard.Analyzers.Tests -name "*.cs" | sort' };

/** A file listing large enough to clear the production 500-char dedup floor. */
const PAYLOAD = Array.from({ length: 120 }, (_, i) => `TcIs.CodeStandard.Analyzers.Tests/Rule${i}Tests.cs`).join("\n");

interface ToolOutput {
  output: string;
}

type Exec = (input: unknown, ctx?: unknown) => Promise<unknown>;

/**
 * Wire the production composition: builtin tool → cumulative cap → cross-turn
 * dedup. The cap budget is deliberately huge so it is a passthrough and the
 * only thing that can rewrite the output is the dedup under test.
 */
function makeAgentLoop(): { dedup: CrossTurnDedup; exec: Exec; realCalls: () => number } {
  const dedup = new CrossTurnDedup();
  let realCalls = 0;
  const base: ToolSet = {
    bash: {
      description: "run a shell command",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        realCalls += 1;
        return { output: PAYLOAD };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal AI ToolSet shape used by the wrappers only
    } as any,
  };
  const cap = wrapToolSetWithCap(base, { maxCumulativeChars: 5_000_000, dedupRepeatOutputs: false });
  const tools = wrapToolSetWithDedup(cap.tools, dedup);
  const exec = (tools.bash as unknown as { execute: Exec }).execute;
  return { dedup, exec, realCalls: () => realCalls };
}

/** Append the assistant tool-call + tool message the AI SDK records per round. */
function appendToolRound(history: ModelMessage[], toolCallId: string, output: string): void {
  history.push({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName: "bash", input: CMD }],
  } as unknown as ModelMessage);
  history.push({
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName: "bash", output: { type: "text", value: output } }],
  } as unknown as ModelMessage);
}

function isPointer(text: string): boolean {
  return text.includes("[dup of");
}

describe("dedup ↔ compaction: a pointer must never name a payload the model lost", () => {
  it("re-serves instead of pointing when cross-turn compaction dropped the referenced result", async () => {
    const { dedup, exec } = makeAgentLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    // Turn 1 — the original call whose result the pointer will name.
    dedup.beginTurn();
    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    expect(first.output).toBe(PAYLOAD);
    appendToolRound(history, "call_237", first.output);
    history.push({ role: "assistant", content: "Found the test files." } as ModelMessage);
    history.push({ role: "user", content: "now add the missing analyzer" } as ModelMessage);
    history.push({ role: "assistant", content: "Starting on it." } as ModelMessage);

    // REAL compaction decides the cut — this is the drop site the incident hit
    // (orchestrator.compactForContext → prepareCompaction → keptMessages).
    const prepared = prepareCompaction(history, "system prompt", { reserveTokens: 16_384, keepRecentTokens: 20 });
    expect(prepared).not.toBeNull();
    const afterCompaction: ModelMessage[] = [
      createCompactionSummaryMessage("checkpoint"),
      ...(prepared?.keptMessages ?? []),
    ];
    // Evidence the payload really is unreachable now, not merely assumed to be.
    expect(JSON.stringify(afterCompaction)).not.toContain("call_237");

    // Turn 2 — the identical call. It must NOT be answered with a pointer at
    // a result that no longer exists.
    dedup.beginTurn();
    const second = (await exec(CMD, { toolCallId: "call_239", messages: afterCompaction })) as ToolOutput;
    expect(isPointer(second.output)).toBe(false);
    expect(second.output).toBe(PAYLOAD);
  });

  it("still collapses a genuine duplicate while the referenced result IS reachable", async () => {
    const { dedup, exec } = makeAgentLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    dedup.beginTurn();
    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    expect(first.output).toBe(PAYLOAD);
    appendToolRound(history, "call_237", first.output);
    history.push({ role: "user", content: "remind me what was in there" } as ModelMessage);

    // No compaction: call_237's result is still verbatim in the history the
    // model receives, so the pointer is resolvable and dedup must still fire.
    dedup.beginTurn();
    const second = (await exec(CMD, { toolCallId: "call_241", messages: [...history] })) as ToolOutput;
    expect(isPointer(second.output)).toBe(true);
    expect(second.output).toContain("bash");
    expect(second.output).toContain("turn 1");
    expect(second.output.length).toBeLessThan(PAYLOAD.length);
    expect(dedup.getStats().hits).toBe(1);
  });

  it("breaks the nine-call loop shape: post-compaction repeats are not all pointers", async () => {
    const { dedup, exec } = makeAgentLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    dedup.beginTurn();
    const seed = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    appendToolRound(history, "call_237", seed.output);
    history.push({ role: "assistant", content: "Found the test files." } as ModelMessage);
    history.push({ role: "user", content: "now add the missing analyzer" } as ModelMessage);
    history.push({ role: "assistant", content: "Starting on it." } as ModelMessage);

    const prepared = prepareCompaction(history, "system prompt", { reserveTokens: 16_384, keepRecentTokens: 20 });
    const live: ModelMessage[] = [createCompactionSummaryMessage("checkpoint"), ...(prepared?.keptMessages ?? [])];
    expect(JSON.stringify(live)).not.toContain("call_237");

    // The measured loop: nine identical calls, each its own turn, each round
    // appended to the live history exactly as the SDK would.
    const outputs: string[] = [];
    for (let i = 0; i < 9; i++) {
      dedup.beginTurn();
      const id = `call_${300 + i}`;
      const res = (await exec(CMD, { toolCallId: id, messages: [...live] })) as ToolOutput;
      outputs.push(res.output);
      appendToolRound(live, id, res.output);
    }

    // The loop is broken because the model actually RECEIVES the data it keeps
    // asking for — on the first post-compaction call.
    expect(outputs[0]).toBe(PAYLOAD);
    expect(outputs.filter((o) => isPointer(o)).length).toBeLessThan(9);
    // …and dedup is not weakened: once the payload is back in view, every
    // further repeat collapses to a pointer at a result that IS reachable.
    expect(outputs.slice(1).every((o) => isPointer(o))).toBe(true);
  });

  it("re-serves after the in-loop compactor elided the referenced result", async () => {
    // The prepareStep compactor (B3 sub-agent / B4 top-level) rewrites old
    // tool-result outputs into stubs for the wire only. The AI SDK hands tool
    // execute() `stepInputMessages` — the UNCOMPACTED array (ai/dist/index.mjs
    // :4422) — so scanning ctx.messages cannot see this elision. The compactor
    // has to report it.
    const { dedup, exec } = makeAgentLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    dedup.beginTurn();
    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    appendToolRound(history, "call_237", first.output);
    // Filler rounds so the compactor's keepLast window pushes call_237 out.
    for (let i = 0; i < 4; i++) {
      appendToolRound(history, `call_filler_${i}`, `unrelated output ${i} ${"y".repeat(4_000)}`);
    }

    const elided: string[] = [];
    const compacted = compactSubAgentMessages(history, {
      thresholdChars: 1_000,
      keepLastTurns: 1,
      onElide: (ids: string[]) => elided.push(...ids),
    });
    // Evidence: the model's wire view no longer carries call_237's payload.
    expect(compacted).not.toBe(history);
    expect(JSON.stringify(compacted)).not.toContain(PAYLOAD.slice(0, 80));
    expect(elided).toContain("call_237");

    dedup.noteElided(elided);

    // ctx.messages is the uncompacted array — it still "contains" call_237.
    // The ledger must nonetheless refuse to point at it.
    dedup.beginTurn();
    const second = (await exec(CMD, { toolCallId: "call_400", messages: [...history] })) as ToolOutput;
    expect(isPointer(second.output)).toBe(false);
    expect(second.output).toBe(PAYLOAD);
  });
});

/**
 * The layer that actually minted the measured pointer.
 *
 * `[dup of call #237 — reuse it]` is 29 characters and is `sub-agent-cap.ts`'s
 * marker, not the cross-turn dedup's — matching the 29-char tool_result rows in
 * the incident exactly. This one is worse than a merely stale pointer: `#237` is
 * an internal per-invocation call counter that appears NOWHERE in the model's
 * context, so it named nothing the model could look up and nothing
 * `retrieve_tool_result` (keyed on tool_call_id) could fetch.
 */
describe("sub-agent cap dedup ↔ compaction", () => {
  function makeCappedLoop(): { state: SubAgentCapState; exec: Exec } {
    const base: ToolSet = {
      bash: {
        description: "run a shell command",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ output: PAYLOAD }),
        // biome-ignore lint/suspicious/noExplicitAny: minimal AI ToolSet shape used by the wrapper only
      } as any,
    };
    // Wired as stream-runner.ts does: dedupRepeatOutputs defaults ON, budget
    // large enough that no tier trimming interferes with the assertions.
    const cap = wrapToolSetWithCap(base, { maxCumulativeChars: 5_000_000 });
    const exec = (cap.tools.bash as unknown as { execute: Exec }).execute;
    return { state: cap.state, exec };
  }

  function isCapPointer(text: string): boolean {
    return text.includes("[dup of call #");
  }

  it("re-serves instead of pointing when compaction dropped the referenced result", async () => {
    const { exec } = makeCappedLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    expect(first.output).toBe(PAYLOAD);
    appendToolRound(history, "call_237", first.output);
    history.push({ role: "assistant", content: "Found the test files." } as ModelMessage);
    history.push({ role: "user", content: "now add the missing analyzer" } as ModelMessage);
    history.push({ role: "assistant", content: "Starting on it." } as ModelMessage);

    const prepared = prepareCompaction(history, "system prompt", { reserveTokens: 16_384, keepRecentTokens: 20 });
    const afterCompaction: ModelMessage[] = [
      createCompactionSummaryMessage("checkpoint"),
      ...(prepared?.keptMessages ?? []),
    ];
    expect(JSON.stringify(afterCompaction)).not.toContain("call_237");

    const second = (await exec(CMD, { toolCallId: "call_239", messages: afterCompaction })) as ToolOutput;
    expect(isCapPointer(second.output)).toBe(false);
    expect(second.output).toBe(PAYLOAD);
  });

  it("still collapses a genuine duplicate, and names a handle that can be resolved", async () => {
    const { state, exec } = makeCappedLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    appendToolRound(history, "call_237", first.output);

    const second = (await exec(CMD, { toolCallId: "call_241", messages: [...history] })) as ToolOutput;
    expect(isCapPointer(second.output)).toBe(true);
    expect(second.output.length).toBeLessThan(PAYLOAD.length);
    expect(state.dedupHits).toBe(1);
    // The pointer must name the anchor's tool_call_id — otherwise it references
    // a per-invocation counter the model has never seen and cannot look up.
    expect(second.output).toContain("id=call_237");
  });

  it("re-serves after the in-loop compactor elided the referenced result", async () => {
    const { state, exec } = makeCappedLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    const first = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    appendToolRound(history, "call_237", first.output);
    for (let i = 0; i < 4; i++) {
      appendToolRound(history, `call_filler_${i}`, `unrelated output ${i} ${"y".repeat(4_000)}`);
    }

    const elided: string[] = [];
    const compacted = compactSubAgentMessages(history, {
      thresholdChars: 1_000,
      keepLastTurns: 1,
      onElide: (ids: string[]) => elided.push(...ids),
    });
    expect(JSON.stringify(compacted)).not.toContain(PAYLOAD.slice(0, 80));
    expect(elided).toContain("call_237");
    noteElidedForCap(state, elided);

    // ctx.messages is the pre-prepareStep array and still "contains" call_237 —
    // only the compactor's report can reveal the loss.
    const second = (await exec(CMD, { toolCallId: "call_400", messages: [...history] })) as ToolOutput;
    expect(isCapPointer(second.output)).toBe(false);
    expect(second.output).toBe(PAYLOAD);
  });

  it("breaks the nine-call loop shape: post-compaction repeats are not all pointers", async () => {
    const { exec } = makeCappedLoop();
    const history: ModelMessage[] = [{ role: "user", content: "list the analyzer test files" }];

    const seed = (await exec(CMD, { toolCallId: "call_237", messages: [...history] })) as ToolOutput;
    appendToolRound(history, "call_237", seed.output);
    history.push({ role: "assistant", content: "Found the test files." } as ModelMessage);
    history.push({ role: "user", content: "now add the missing analyzer" } as ModelMessage);
    history.push({ role: "assistant", content: "Starting on it." } as ModelMessage);

    const prepared = prepareCompaction(history, "system prompt", { reserveTokens: 16_384, keepRecentTokens: 20 });
    const live: ModelMessage[] = [createCompactionSummaryMessage("checkpoint"), ...(prepared?.keptMessages ?? [])];
    expect(JSON.stringify(live)).not.toContain("call_237");

    const outputs: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = `call_${300 + i}`;
      const res = (await exec(CMD, { toolCallId: id, messages: [...live] })) as ToolOutput;
      outputs.push(res.output);
      appendToolRound(live, id, res.output);
    }

    expect(outputs[0]).toBe(PAYLOAD);
    expect(outputs.filter((o) => isCapPointer(o)).length).toBeLessThan(9);
    // Dedup intact: once the payload is back in view, every repeat collapses.
    expect(outputs.slice(1).every((o) => isCapPointer(o))).toBe(true);
  });
});
