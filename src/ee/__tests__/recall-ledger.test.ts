import { describe, expect, it } from "vitest";
import { createRecallLedger } from "../recall-ledger.js";

describe("recall-ledger", () => {
  it("records entries as pending and counts them", () => {
    const l = createRecallLedger();
    l.record(
      [
        { id: "a", collection: "c1" },
        { id: "b", collection: null },
      ],
      "q1",
    );
    expect(l.pendingCount()).toBe(2);
    const pending = l.pending();
    expect(pending.map((p) => p.id)).toEqual(["a", "b"]);
    expect(pending[0]!.query).toBe("q1");
  });

  it("first sighting wins — re-recording an unrated id keeps the original query", () => {
    const l = createRecallLedger();
    l.record([{ id: "a", collection: "c1" }], "first");
    l.record([{ id: "a", collection: "c1" }], "second");
    expect(l.pendingCount()).toBe(1);
    expect(l.pending()[0]!.query).toBe("first");
  });

  it("clear() removes a rated id and reports whether it was pending", () => {
    const l = createRecallLedger();
    l.record([{ id: "a", collection: "c1" }], "q");
    expect(l.clear("a")).toBe(true);
    expect(l.clear("a")).toBe(false); // already gone
    expect(l.pendingCount()).toBe(0);
  });

  it("ignores entries with empty/missing ids and non-array input", () => {
    const l = createRecallLedger();
    l.record(
      [
        { id: "", collection: "c" },
        { id: "  ", collection: "c" },
      ],
      "q",
    );
    l.record(undefined, "q");
    expect(l.pendingCount()).toBe(0);
  });

  it("isPending() tracks unrated debt — the cross-turn re-injection suppressor", () => {
    const l = createRecallLedger();
    expect(l.isPending("a")).toBe(false); // never recorded
    l.record([{ id: "a", collection: "c1" }], "q");
    expect(l.isPending("a")).toBe(true); // surfaced this session → Layer 3 skips re-injecting its body
    expect(l.isPending(" a ")).toBe(true); // trimmed match
    l.clear("a");
    expect(l.isPending("a")).toBe(false); // rated → no longer pending
    expect(l.wasCleared("a")).toBe(true); // but still suppressed via wasCleared
  });

  it("reset() empties the ledger", () => {
    const l = createRecallLedger();
    l.record([{ id: "a", collection: "c" }], "q");
    l.reset();
    expect(l.pendingCount()).toBe(0);
  });
});
