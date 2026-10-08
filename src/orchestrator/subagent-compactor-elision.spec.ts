/**
 * F10 — an args elision must never make the prompt BIGGER.
 *
 * The pre-F10 gate was `sz < 80`, while the marker it substitutes serialises to
 * 133-137 chars. Everything in the 80..133 band was therefore replaced by
 * something LARGER. `subagent-compactor.spec.ts` never caught it because its
 * fixture builds tool-call args with `"y".repeat(500)` — a single point that
 * only ever exercises the band where elision genuinely wins.
 *
 * These cases use the MEASURED distribution of real tool-call arguments instead
 * (703 rows of `tool_calls` in ~/.muonroi-cli/muonroi.db, sizes computed with
 * the same `JSON.stringify(input)` the compactor uses): p25=88, p50=115,
 * p75=166, p90=571, max=12704. The 80..200 band alone holds 449 of those calls,
 * and at the old threshold the marker was net -7,430 chars (-14.1%) across it,
 * inflating 342 of 449.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  buildElidedArgsInput,
  compactSubAgentMessages,
  isCompactorElisionMarker,
  MIN_ELIDE_ARGS_CHARS,
} from "./subagent-compactor.js";

/** Serialised size of a tool-call input, exactly as the compactor computes it. */
function inputChars(input: unknown): number {
  return typeof input === "string" ? input.length : JSON.stringify(input ?? "").length;
}

/**
 * Build an assistant tool-call whose serialised input is `targetChars` long,
 * shaped like a real `{path: ...}` argument object. The padding grows a
 * plausible VALUE rather than inventing keys, so the fixture stays
 * representative of what the model actually emits.
 */
function callWithArgSize(idx: number, targetChars: number, toolName: string): ModelMessage {
  let pad = 1;
  let input: Record<string, unknown> = { path: "src/a.ts" };
  while (inputChars(input) < targetChars) {
    pad++;
    input = { path: `src/${"a".repeat(pad)}.ts` };
  }
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: `call_${idx}`, toolName, input }],
  } as unknown as ModelMessage;
}

function resultFor(idx: number, toolName: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call_${idx}`,
        toolName,
        // Large + low-signal, so the turn is well above threshold and is not
        // auto-kept by isHighValueToolResult's src/ + error/plan heuristics.
        output: { type: "text", value: "z".repeat(20_000) },
      },
    ],
  } as unknown as ModelMessage;
}

/** Measured percentiles, plus the exact break-even boundaries around the marker. */
const REALISTIC_ARG_SIZES = [60, 80, 88, 102, 109, 115, 133, 134, 135, 166, 199, 200, 256, 300, 571, 4395, 12704];

function historyWithArgSizes(sizes: readonly number[]): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "system", content: "You are the Explore sub-agent." },
    { role: "user", content: "research auth wiring" },
  ];
  sizes.forEach((sz, i) => {
    msgs.push(callWithArgSize(i + 1, sz, "other_tool"), resultFor(i + 1, "other_tool"));
  });
  return msgs;
}

/** keepLastTurns:0 so EVERY turn is eligible; explicit threshold so the test
 * never silently passes because the fixture fell under the size gate. */
const COMPACT_ALL = { keepLastTurns: 0, thresholdChars: 1_000 } as const;

function toolCallInputs(msgs: readonly ModelMessage[]): Array<{ id: string; input: unknown }> {
  const out: Array<{ id: string; input: unknown }> = [];
  for (const m of msgs) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content as unknown as ReadonlyArray<Record<string, unknown>>) {
      if (part.type !== "tool-call") continue;
      out.push({ id: part.toolCallId as string, input: part.input });
    }
  }
  return out;
}

describe("subagent-compactor: F10 args elision never inflates", () => {
  it("never increases the serialised size of any tool-call input, across a realistic size distribution", () => {
    const msgs = historyWithArgSizes(REALISTIC_ARG_SIZES);
    const before = new Map(toolCallInputs(msgs).map((c) => [c.id, inputChars(c.input)]));
    expect(before.size).toBe(REALISTIC_ARG_SIZES.length);

    const after = toolCallInputs(compactSubAgentMessages(msgs, COMPACT_ALL));
    expect(after).toHaveLength(REALISTIC_ARG_SIZES.length);

    let shrunk = 0;
    for (const { id, input } of after) {
      const originalChars = before.get(id);
      expect(originalChars, `unknown tool call ${id}`).toBeTypeOf("number");
      const afterChars = inputChars(input);
      // THE INVARIANT: compaction is not allowed to cost chars.
      expect(afterChars, `elision inflated call ${id}: ${originalChars} -> ${afterChars} chars`).toBeLessThanOrEqual(
        originalChars as number,
      );
      if (afterChars < (originalChars as number)) shrunk++;
    }
    // Sanity: the fixture must still exercise the winning band, or the invariant
    // above would pass vacuously by never eliding anything at all.
    expect(shrunk).toBeGreaterThan(0);
  });

  it("leaves short-path arguments untouched — the population the model was imitating", () => {
    // 235 of the 593 pre-F10 elisions were read_file calls, and 195 of those
    // (83%) inflated. At MIN_ELIDE_ARGS_CHARS only 3 of the 235 still qualify.
    //
    // These sizes are PINNED LITERALS, deliberately not derived from
    // MIN_ELIDE_ARGS_CHARS. Deriving them lets a regression that lowers the
    // constant also shrink the fixture, so the loop below would pass over an
    // empty band and assert nothing — which is exactly what an earlier draft of
    // this test did (at threshold 80 the fixture collapsed to a single 60-char
    // call and the test went green while calls of 135-200 chars were being
    // inflated). The band below is the measured short-path population.
    const SHORT_PATH_ARG_SIZES = [60, 80, 88, 102, 109, 115, 133, 134, 135, 166, 199, 200, 255];
    const after = toolCallInputs(compactSubAgentMessages(historyWithArgSizes(SHORT_PATH_ARG_SIZES), COMPACT_ALL));
    expect(after).toHaveLength(SHORT_PATH_ARG_SIZES.length);
    for (const { id, input } of after) {
      expect(isCompactorElisionMarker(input), `call ${id} should not have been elided`).toBe(false);
    }
    // And pin the constant itself, so it cannot be lowered back into that band.
    expect(MIN_ELIDE_ARGS_CHARS).toBeGreaterThan(SHORT_PATH_ARG_SIZES[SHORT_PATH_ARG_SIZES.length - 1]!);
  });

  it("the threshold sits above the marker's own serialised length at every digit count", () => {
    // Guards the constant against the marker sentence being edited longer later:
    // `sz` appears in the text, so the marker grows one char per digit decade.
    for (const sz of [80, 999, 9_999, 999_999, 999_999_999]) {
      const markerChars = JSON.stringify(buildElidedArgsInput(sz)).length;
      expect(
        markerChars,
        `marker for sz=${sz} is ${markerChars} chars, not below threshold ${MIN_ELIDE_ARGS_CHARS}`,
      ).toBeLessThan(MIN_ELIDE_ARGS_CHARS);
    }
  });

  it("still elides — and materially shrinks — genuinely large arguments", () => {
    const after = toolCallInputs(compactSubAgentMessages(historyWithArgSizes([4395, 12704]), COMPACT_ALL));
    const elided = after.filter((c) => isCompactorElisionMarker(c.input));
    expect(elided).toHaveLength(2);
    for (const c of elided) expect(inputChars(c.input)).toBeLessThan(200);
  });

  it("an elided input is still a wire-valid JSON object (StepFun `arguments | fromjson`)", () => {
    const after = toolCallInputs(compactSubAgentMessages(historyWithArgSizes([4395]), COMPACT_ALL));
    const elided = after.filter((c) => isCompactorElisionMarker(c.input));
    expect(elided).toHaveLength(1);
    // What goes on the wire is JSON.stringify(input); it must parse back to a
    // non-null, non-array OBJECT or the Jinja chat template 400s the request.
    const onWire = JSON.parse(JSON.stringify(elided[0]!.input));
    expect(typeof onWire).toBe("object");
    expect(onWire).not.toBeNull();
    expect(Array.isArray(onWire)).toBe(false);
  });

  it("re-compacting a realistic distribution is byte-for-byte idempotent (cache-prefix stability)", () => {
    const msgs = historyWithArgSizes(REALISTIC_ARG_SIZES);
    const once = compactSubAgentMessages(msgs, COMPACT_ALL);
    const twice = compactSubAgentMessages(once, COMPACT_ALL);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
