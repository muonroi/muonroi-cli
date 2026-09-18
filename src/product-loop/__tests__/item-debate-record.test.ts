/**
 * C3 — `item-debate-record.ts`'s pure per-item record builder.
 *
 * Independent of any wiring into a real per-item debate (that's a later
 * slice) — this suite pins down bounding + the "no_verdict on parse failure,
 * never a silent approve" discipline signal by signal.
 */

import { describe, expect, it } from "vitest";
import type { DebatableItem } from "../debatable-items.js";
import {
  buildSprintItemDebateItem,
  MAX_ITEM_DEBATE_TEXT_CHARS,
  MAX_POSITION_CHARS,
  MAX_POSITIONS,
} from "../item-debate-record.js";

function taskItem(overrides: Partial<DebatableItem> = {}): DebatableItem {
  return {
    kind: "task",
    id: "step3",
    title: "Implement the rate limiter",
    signal: "vague-criterion",
    reason: "Task step3 has no done criterion at all.",
    ...overrides,
  };
}

function criterionItem(overrides: Partial<DebatableItem> = {}): DebatableItem {
  return {
    kind: "criterion",
    id: "crit-abc",
    title: "dotnet test passes with 0 failures",
    signal: "undebated-criterion",
    reason: "No panelist took a position on this criterion during the debate.",
    ...overrides,
  };
}

describe("buildSprintItemDebateItem", () => {
  it("maps a task-kind item's id to taskId, not criterionId", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem() });
    expect(rec.kind).toBe("task");
    expect(rec.taskId).toBe("step3");
    expect(rec.criterionId).toBeUndefined();
  });

  it("maps a criterion-kind item's id to criterionId, not taskId", () => {
    const rec = buildSprintItemDebateItem({ item: criterionItem() });
    expect(rec.kind).toBe("criterion");
    expect(rec.criterionId).toBe("crit-abc");
    expect(rec.taskId).toBeUndefined();
  });

  it("no leaderRulingRaw at all -> no_verdict / none, never a silent approve", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem() });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.changeKind).toBe("none");
    expect(rec.proposedChange).toBeUndefined();
  });

  it("leaderRulingRaw with no JSON block -> no_verdict / none", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: "The task looks fine to me, no changes needed.",
    });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.changeKind).toBe("none");
  });

  it("leaderRulingRaw with malformed JSON -> no_verdict / none", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: '{"ruling": "criterion is vague", "changeKind": "criterion", ', // truncated / invalid
    });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.changeKind).toBe("none");
  });

  it("leaderRulingRaw with valid JSON but no ruling field -> no_verdict / none", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({ changeKind: "criterion", change: { criterionText: "x" } }),
    });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.changeKind).toBe("none");
  });

  it("leaderRulingRaw with an unrecognized changeKind falls back to none but KEEPS the ruling text", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({ ruling: "the panel converged", changeKind: "rewrite-everything" }),
    });
    expect(rec.leaderRuling).toBe("the panel converged");
    expect(rec.changeKind).toBe("none");
    expect(rec.proposedChange).toBeUndefined();
  });

  it("a well-formed criterion ruling round-trips changeKind + proposedChange", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({
        ruling: "The criterion is too vague; tighten it.",
        changeKind: "criterion",
        change: { criterionText: "dotnet test src/Sample.Tests passes with 0 failures" },
      }),
    });
    expect(rec.leaderRuling).toBe("The criterion is too vague; tighten it.");
    expect(rec.changeKind).toBe("criterion");
    expect(rec.proposedChange?.criterionText).toBe("dotnet test src/Sample.Tests passes with 0 failures");
  });

  it("a well-formed dependency ruling carries dependsOnId", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({
        ruling: "step3 actually needs step1 finished first.",
        changeKind: "dependency",
        change: { dependsOnId: "step1" },
      }),
    });
    expect(rec.changeKind).toBe("dependency");
    expect(rec.proposedChange?.dependsOnId).toBe("step1");
  });

  it("a well-formed split ruling carries splitTitles", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({
        ruling: "Too much surface area — split it.",
        changeKind: "split",
        change: { splitTitles: ["Implement the token bucket", "Wire it into the request pipeline"] },
      }),
    });
    expect(rec.changeKind).toBe("split");
    expect(rec.proposedChange?.splitTitles).toEqual([
      "Implement the token bucket",
      "Wire it into the request pipeline",
    ]);
  });

  it("a well-formed drop ruling carries a note", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({
        ruling: "This task duplicates step1's scope entirely.",
        changeKind: "drop",
        change: { note: "duplicate of step1" },
      }),
    });
    expect(rec.changeKind).toBe("drop");
    expect(rec.proposedChange?.note).toBe("duplicate of step1");
  });

  it("bounds title, selectionReason, leaderRuling and proposedChange text", () => {
    const longText = "x".repeat(MAX_ITEM_DEBATE_TEXT_CHARS + 50);
    const rec = buildSprintItemDebateItem({
      item: taskItem({ title: longText, reason: longText }),
      leaderRulingRaw: JSON.stringify({
        ruling: longText,
        changeKind: "criterion",
        change: { criterionText: longText, note: longText },
      }),
    });
    expect(rec.title.length).toBeLessThanOrEqual(MAX_ITEM_DEBATE_TEXT_CHARS + 1); // +1 for the ellipsis char
    expect(rec.selectionReason.length).toBeLessThanOrEqual(MAX_ITEM_DEBATE_TEXT_CHARS + 1);
    expect(rec.leaderRuling.length).toBeLessThanOrEqual(MAX_ITEM_DEBATE_TEXT_CHARS + 1);
    expect(rec.proposedChange?.criterionText?.length).toBeLessThanOrEqual(MAX_ITEM_DEBATE_TEXT_CHARS + 1);
  });

  it("bounds each position's stance text and caps the number of positions", () => {
    const many = Array.from({ length: MAX_POSITIONS + 5 }, (_, i) => ({
      role: `panelist-${i}`,
      text: "y".repeat(MAX_POSITION_CHARS + 40),
    }));
    const rec = buildSprintItemDebateItem({ item: taskItem(), positions: many });
    expect(rec.positions.length).toBe(MAX_POSITIONS);
    for (const p of rec.positions) {
      expect(p.stance.length).toBeLessThanOrEqual(MAX_POSITION_CHARS + 1);
    }
  });

  it("drops a position with an empty/blank role", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      positions: [
        { role: "  ", text: "should be dropped" },
        { role: "leader", text: "kept" },
      ],
    });
    expect(rec.positions).toEqual([{ role: "leader", stance: "kept" }]);
  });

  it("no positions given -> empty array, never undefined", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem() });
    expect(rec.positions).toEqual([]);
  });
});
