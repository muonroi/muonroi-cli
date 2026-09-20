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
  MAX_RULING_RAW_TAIL_CHARS,
  parseLeaderRuling,
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

/**
 * D8 — a diagnosable `no_verdict`, plus the wider set of reply shapes a real
 * model actually emits. Live run `mu75rurpf9ec` recorded `no_verdict` for
 * every item across both sprints with nothing to say why; these tests pin
 * both halves of the fix: what now PARSES, and what a still-unparseable (or
 * never-attempted) call now RECORDS about itself.
 */
describe("parseLeaderRuling — accepted shapes", () => {
  it("a fenced ```json block parses", () => {
    const raw = '```json\n{"ruling": "fine as written", "changeKind": "none"}\n```';
    const result = parseLeaderRuling(raw);
    expect(result.leaderRuling).toBe("fine as written");
    expect(result.changeKind).toBe("none");
    expect(result.failedAt).toBeUndefined();
  });

  it("a bare ``` fence (no 'json' tag) parses", () => {
    const raw = '```\n{"ruling": "fine as written", "changeKind": "none"}\n```';
    const result = parseLeaderRuling(raw);
    expect(result.leaderRuling).toBe("fine as written");
  });

  it("an object wrapped in leading and trailing prose parses, ignoring trailing braces", () => {
    const raw =
      'Sure, here is my ruling: {"ruling": "the criterion is too vague", "changeKind": "none"} ' +
      "Let me know if you have any questions {smiley}.";
    const result = parseLeaderRuling(raw);
    expect(result.leaderRuling).toBe("the criterion is too vague");
    expect(result.changeKind).toBe("none");
  });

  it("keys in a different case (Ruling, ChangeKind, Change) parse", () => {
    const raw = JSON.stringify({
      Ruling: "step3 needs step1 first",
      ChangeKind: "dependency",
      Change: { DependsOnId: "step1" },
    });
    const result = parseLeaderRuling(raw);
    expect(result.leaderRuling).toBe("step3 needs step1 first");
    expect(result.changeKind).toBe("dependency");
    expect(result.proposedChange?.dependsOnId).toBe("step1");
  });

  it("changeKind value itself in a different case (Dependency) still matches", () => {
    const raw = JSON.stringify({
      ruling: "needs step1 first",
      changeKind: "Dependency",
      change: { dependsOnId: "step1" },
    });
    const result = parseLeaderRuling(raw);
    expect(result.changeKind).toBe("dependency");
  });

  it("a `change` value that is a plain string folds into note, never dropped", () => {
    const raw = JSON.stringify({
      ruling: "this task duplicates step1",
      changeKind: "drop",
      change: "duplicate of step1's scope",
    });
    const result = parseLeaderRuling(raw);
    expect(result.changeKind).toBe("drop");
    expect(result.proposedChange?.note).toBe("duplicate of step1's scope");
  });
});

describe("parseLeaderRuling — failedAt on every no_verdict path", () => {
  it("empty/blank reply -> failedAt empty_reply", () => {
    expect(parseLeaderRuling("").failedAt).toBe("empty_reply");
    expect(parseLeaderRuling("   ").failedAt).toBe("empty_reply");
    expect(parseLeaderRuling(undefined).failedAt).toBe("empty_reply");
  });

  it("no JSON block at all -> failedAt no_json_block", () => {
    expect(parseLeaderRuling("The task looks fine to me.").failedAt).toBe("no_json_block");
  });

  it("an unbalanced/truncated brace -> failedAt no_json_block", () => {
    expect(parseLeaderRuling('{"ruling": "vague", ').failedAt).toBe("no_json_block");
  });

  it("a balanced but invalid JSON body -> failedAt invalid_json", () => {
    // Balanced braces (so extractBalancedJson succeeds) but not valid JSON inside.
    expect(parseLeaderRuling("{ruling: fine, changeKind: none}").failedAt).toBe("invalid_json");
  });

  it("valid JSON with no ruling field -> failedAt missing_ruling", () => {
    const raw = JSON.stringify({ changeKind: "criterion", change: { criterionText: "x" } });
    expect(parseLeaderRuling(raw).failedAt).toBe("missing_ruling");
  });
});

describe("buildSprintItemDebateItem — rulingDebug diagnostics (D8)", () => {
  it("no reply at all, no diagnostics supplied -> rulingDebug reflects the parse failure directly", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem() });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.rulingDebug).toEqual({ reason: "empty_reply", attempts: 0 });
  });

  it("rulingSkipReason set -> rulingDebug.reason is no_call, regardless of any parse outcome", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      rulingSkipReason: "the item debate's shared deadline had already fired",
    });
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.rulingDebug).toEqual({
      reason: "no_call",
      attempts: 0,
      errorDetail: "the item debate's shared deadline had already fired",
    });
  });

  it("rulingCallError with no raw reply -> rulingDebug.reason is call_error", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      rulingAttempts: 1,
      rulingCallError: "Aborted",
    });
    expect(rec.rulingDebug).toEqual({ reason: "call_error", attempts: 1, errorDetail: "Aborted" });
  });

  it("a raw reply that did not parse -> rulingDebug carries the failedAt reason and a rawTail", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: "The task looks fine to me, no changes needed.",
    });
    expect(rec.rulingDebug).toEqual({
      reason: "no_json_block",
      attempts: 1,
      rawTail: "The task looks fine to me, no changes needed.",
    });
  });

  it("rawTail is bounded to MAX_RULING_RAW_TAIL_CHARS and keeps the TAIL, not the head", () => {
    const head = "x".repeat(50);
    const tail = "y".repeat(50);
    const raw = head + "z".repeat(MAX_RULING_RAW_TAIL_CHARS + 100) + tail;
    const rec = buildSprintItemDebateItem({ item: taskItem(), leaderRulingRaw: raw });
    expect(rec.rulingDebug?.rawTail?.length).toBe(MAX_RULING_RAW_TAIL_CHARS);
    expect(rec.rulingDebug?.rawTail?.endsWith(tail)).toBe(true);
    expect(rec.rulingDebug?.rawTail?.includes(head)).toBe(false);
  });

  it("a successful ruling never carries rulingDebug", () => {
    const rec = buildSprintItemDebateItem({
      item: taskItem(),
      leaderRulingRaw: JSON.stringify({ ruling: "fine as written", changeKind: "none" }),
    });
    expect(rec.rulingDebug).toBeUndefined();
  });

  it("rulingAttempts defaults to 1 when leaderRulingRaw is set and the caller did not say otherwise", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem(), leaderRulingRaw: "not json" });
    expect(rec.rulingDebug?.attempts).toBe(1);
  });

  it("an explicit rulingAttempts of 2 (after a retry) is recorded even though the retry still failed", () => {
    const rec = buildSprintItemDebateItem({ item: taskItem(), leaderRulingRaw: "still not json", rulingAttempts: 2 });
    expect(rec.rulingDebug?.attempts).toBe(2);
  });
});

/**
 * D8.4 — a fixture built from the real item text in live run `mu75rurpf9ec`'s
 * own `sprints/1-item-debate.json` / `1-plan.json` (read-only; paraphrased
 * into neutral English rather than copied verbatim), so this suite exercises
 * the actual shape (long Vietnamese-sourced titles, an id with a `#hash`
 * suffix, an "undebated-criterion" selection signal with empty positions) —
 * not a synthetic short-title stand-in.
 */
describe("buildSprintItemDebateItem — realistic fixture from run mu75rurpf9ec", () => {
  function realisticCriterionItem(overrides: Partial<DebatableItem> = {}): DebatableItem {
    return {
      kind: "criterion",
      // Paraphrased from "Có thể tắt từng rule qua #pragma và .editorconfig
      // với key dotnet_diagnostic.<rule-id>.severity #100857" — a real
      // criterion id carries a trailing `#<hash>` suffix.
      id: "Each rule can be suppressed per-line and per-project via a config key #100857",
      title:
        "Each analyzer rule can be individually suppressed via an inline pragma and via a project config key " +
        "of the form <analyzer>.<rule-id>.severity",
      signal: "undebated-criterion",
      reason: "No panelist took a position on this criterion during the debate.",
      ...overrides,
    };
  }

  it("an unparseable reply on the realistic item still records a full rulingDebug, never a silent approve", () => {
    const rec = buildSprintItemDebateItem({
      item: realisticCriterionItem(),
      leaderRulingRaw:
        "Looking at this criterion, I think the panel's position was reasonable and no change is needed here.",
    });
    expect(rec.kind).toBe("criterion");
    expect(rec.leaderRuling).toBe("no_verdict");
    expect(rec.changeKind).toBe("none");
    expect(rec.rulingDebug?.reason).toBe("no_json_block");
    expect(rec.rulingDebug?.rawTail).toBeTruthy();
  });

  it("a realistic fenced reply for the same item parses cleanly end to end", () => {
    const rec = buildSprintItemDebateItem({
      item: realisticCriterionItem(),
      leaderRulingRaw: '```json\n{"ruling": "the criterion is specific enough as written", "changeKind": "none"}\n```',
    });
    expect(rec.leaderRuling).toBe("the criterion is specific enough as written");
    expect(rec.changeKind).toBe("none");
    expect(rec.rulingDebug).toBeUndefined();
  });
});
