import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../types/index.js";
import { mergeLocalEntries, reconcileTranscript } from "../local-entries.js";

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 10, 0, s));
const user = (content: string, s: number, extra: Partial<ChatEntry> = {}): ChatEntry => ({
  type: "user",
  content,
  timestamp: at(s),
  ...extra,
});
const assistant = (content: string, s: number, extra: Partial<ChatEntry> = {}): ChatEntry => ({
  type: "assistant",
  content,
  timestamp: at(s),
  ...extra,
});
const texts = (entries: ChatEntry[]) => entries.map((e) => e.content);

describe("mergeLocalEntries", () => {
  it("re-inserts a local entry between the saved entries that surround it in time", () => {
    const fresh = [user("first", 1), assistant("answer 1", 2), user("second", 20), assistant("answer 2", 21)];
    const prev = [...fresh.slice(0, 2), assistant("HELP", 10, { local: true }), ...fresh.slice(2)];
    expect(texts(mergeLocalEntries(fresh, prev))).toEqual(["first", "answer 1", "HELP", "second", "answer 2"]);
  });

  it("keeps on-screen order for equal timestamps and appends locals newer than everything saved", () => {
    const fresh = [user("q", 1), assistant("a", 2)];
    const prev = [
      user("/ideal status", 5, { local: true }),
      assistant("status text", 5, { local: true }),
      assistant("later", 9, { local: true }),
    ];
    expect(texts(mergeLocalEntries(fresh, prev))).toEqual(["q", "a", "/ideal status", "status text", "later"]);
  });

  it("is idempotent across successive rebuilds (a local entry survives every later turn)", () => {
    const local = assistant("HELP", 10, { local: true });
    const turn1 = [user("p1", 1), assistant("a1", 2), user("p2", 20), assistant("a2", 21)];
    const afterTurn1 = mergeLocalEntries(turn1.slice(0, 2), [local]);
    const afterTurn2 = mergeLocalEntries(turn1, afterTurn1);
    expect(texts(afterTurn2)).toEqual(["p1", "a1", "HELP", "p2", "a2"]);
    expect(texts(mergeLocalEntries(turn1, afterTurn2))).toEqual(texts(afterTurn2));
  });

  it("returns the saved entries untouched when nothing is local", () => {
    const fresh = [user("q", 1), assistant("a", 2)];
    expect(mergeLocalEntries(fresh, [user("q", 1), assistant("streamed", 2)])).toEqual(fresh);
  });
});

describe("reconcileTranscript", () => {
  it("does not lend a local user echo's text to the model prompt's entry", () => {
    // On screen: a local `/ideal status` echo, then the real prompt. Saved
    // history holds only the real prompt.
    const prev = [
      user("/ideal status", 5, { local: true }),
      assistant("status text", 5, { local: true }),
      user("do the thing @file.ts", 10),
    ];
    const fresh = [user("do the thing <expanded file.ts>", 10), assistant("done", 11)];
    const out = reconcileTranscript(fresh, prev);
    expect(texts(out)).toEqual(["/ideal status", "status text", "do the thing @file.ts", "done"]);
    expect(out.filter((e) => e.local).map((e) => e.content)).toEqual(["/ideal status", "status text"]);
  });
});
