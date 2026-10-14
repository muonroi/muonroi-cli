/**
 * C1 — the `focus` the main-context agent states via the `compact` tool
 * (src/tools/registry.ts:309) must actually shape the compaction it triggers.
 *
 * Before this, tool-engine.ts consumed `_proactiveCompact.instructions` and then
 * called `runCompaction()` with no reference to it: the agent could say HOW to
 * compact and the answer was dropped on the floor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  compactSubAgentMessages,
  extractFocusTerms,
  FOCUS_NOTE_MAX_CHARS,
  previewMatchesFocus,
} from "./subagent-compactor.js";

/** One assistant tool-call + its tool-result, with caller-chosen body text. */
function toolTurn(idx: number, body: string): ModelMessage[] {
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
          output: { type: "text", value: body },
        },
      ],
    } as unknown as ModelMessage,
  ];
}

const FILLER = "x".repeat(20_000);

/** 8 old turns + 3 fresh ones, well past the 80k default threshold. */
function history(markedTurn: number, marker: string): ModelMessage[] {
  const msgs: ModelMessage[] = [
    { role: "system", content: "You are the agent." },
    { role: "user", content: "do the task" },
  ];
  for (let i = 1; i <= 11; i++) {
    msgs.push(...toolTurn(i, i === markedTurn ? `${marker}\n${FILLER}` : `R${i}\n${FILLER}`));
  }
  return msgs;
}

function stubTexts(msgs: ModelMessage[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      const v = (p.output as { value?: unknown } | undefined)?.value;
      if (typeof v === "string" && v.startsWith("[earlier tool_result")) out.push(v);
    }
  }
  return out;
}

function outputValues(msgs: ModelMessage[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      const v = (p.output as { value?: unknown } | undefined)?.value;
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

describe("C1 — focusNote reaches the elision stub the model reads", () => {
  it("names the agent's focus in every stub it writes", () => {
    const msgs = history(1, "R1");
    const out = compactSubAgentMessages(msgs, {
      label: "top-level",
      focusNote: "keep the migration plan in DESIGN-notes.md",
    });
    const stubs = stubTexts(out);
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) {
      expect(s).toContain("agent focus (kept verbatim where matched): keep the migration plan in DESIGN-notes.md");
    }
  });

  it("writes no focus text when the agent said nothing (unchanged behaviour)", () => {
    const msgs = history(1, "R1");
    const out = compactSubAgentMessages(msgs, { label: "top-level" });
    const stubs = stubTexts(out);
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) expect(s).not.toContain("agent focus");
  });

  it("caps the focus so a long note cannot inflate the prompt", () => {
    const long = `zzz${"y".repeat(FOCUS_NOTE_MAX_CHARS * 3)}`;
    const out = compactSubAgentMessages(history(1, "R1"), { label: "top-level", focusNote: long });
    const stub = stubTexts(out)[0]!;
    expect(stub).toContain(long.slice(0, FOCUS_NOTE_MAX_CHARS));
    expect(stub).not.toContain(long);
  });
});

describe("C1 — focusNote protects the named content from elision", () => {
  it("keeps an OLD tool result verbatim when it contains a focus term", () => {
    const marker = "MARKER src/orchestrator/keepme.ts";
    const msgs = history(2, marker);

    const withoutFocus = compactSubAgentMessages(msgs, { label: "top-level" });
    const withFocus = compactSubAgentMessages(msgs, {
      label: "top-level",
      focusNote: "keep src/orchestrator/keepme.ts open — I still need it",
    });

    const elided = outputValues(withoutFocus).find((v) => v.includes("call_2"));
    expect(elided).toMatch(/^\[earlier tool_result/); // stubbed without a focus

    const kept = outputValues(withFocus).find((v) => v.includes(marker));
    expect(kept).toBeDefined();
    expect(kept).not.toMatch(/^\[earlier tool_result/); // preserved with the focus
    expect(kept?.length).toBeGreaterThan(20_000); // full body, not a preview

    // Non-matching old results are still compacted — the focus is a scalpel.
    expect(stubTexts(withFocus).length).toBeGreaterThan(0);
  });
});

describe("C1 — focus term extraction is exact, not fuzzy", () => {
  it("keeps path-like and long tokens, drops short filler words", () => {
    const terms = extractFocusTerms("keep the src/a/b.ts file and read_file output");
    expect(terms).toContain("src/a/b.ts");
    expect(terms).toContain("read_file");
    expect(terms).not.toContain("keep");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("and");
  });

  it("cannot pin everything from a vague focus", () => {
    // "keep the current sub-task" has no concrete term short enough to match
    // arbitrary tool output.
    const terms = extractFocusTerms("keep the current task");
    expect(previewMatchesFocus("some unrelated grep output", terms)).toBe(false);
  });

  it("matches only by exact case-insensitive containment", () => {
    const terms = extractFocusTerms("src/Foo/Bar.ts");
    expect(previewMatchesFocus("read of SRC/FOO/BAR.TS ok", terms)).toBe(true);
    expect(previewMatchesFocus("src/Foo/Baz.ts", terms)).toBe(false);
  });

  it("returns nothing for an empty focus", () => {
    expect(extractFocusTerms(null)).toEqual([]);
    expect(extractFocusTerms("")).toEqual([]);
    expect(previewMatchesFocus("anything", [])).toBe(false);
  });
});

describe("C1 — tool-engine routes the compact tool's focus into the compaction", () => {
  it("passes the proactive request's instructions to runCompaction", () => {
    const src = readFileSync(join(process.cwd(), "src/orchestrator/tool-engine.ts"), "utf8");
    // The consumed request must be handed to the compaction it triggers...
    expect(src).toContain("runCompaction(_proactiveCompact.instructions)");
    // ...and reach the compactor as focusNote.
    expect(src).toContain("focusNote: resolveFocusNote(focusOverride)");
  });
});
