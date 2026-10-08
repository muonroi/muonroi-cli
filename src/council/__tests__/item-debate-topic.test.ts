/**
 * C2 — item-debate-topic.ts's pure topic builder: turn a C1-selected
 * `DebatableItem` into the round's focus text `runDebate`'s per-round
 * scoping consumes. Pinned independent of the engine wiring (debate.test.ts
 * covers that end-to-end).
 */
import { describe, expect, it } from "vitest";
import type { DebatableItem } from "../../product-loop/debatable-items.js";
import { MAX_TASK_TEXT_CHARS } from "../../product-loop/sprint-plan-artifact.js";
import { buildItemDebateFocus, buildItemDebateTopic } from "../item-debate-topic.js";

function item(overrides: Partial<DebatableItem> & Pick<DebatableItem, "id">): DebatableItem {
  return {
    kind: "task",
    title: "Wire the payment webhook",
    signal: "task-deviation",
    reason: 'Task step3 is not done and the S3b reviewer recorded a deviation: "signature check missing".',
    ...overrides,
  };
}

describe("buildItemDebateTopic", () => {
  it("includes the item id, title, and why it was selected", () => {
    const out = buildItemDebateTopic(item({ id: "step3" }));
    expect(out).toContain("[step3]");
    expect(out).toContain("Wire the payment webhook");
    expect(out).toContain("Why this item was selected (task-deviation)");
    expect(out).toContain("signature check missing");
  });

  it("omits the done-criterion / target lines when no context is supplied", () => {
    const out = buildItemDebateTopic(item({ id: "step3" }));
    expect(out).not.toContain("Done when:");
    expect(out).not.toContain("Target files/dirs:");
  });

  it("folds in the done criterion and target files/dirs when context is supplied", () => {
    const out = buildItemDebateTopic(item({ id: "step3" }), {
      doneCriterion: "dotnet test src/Payments.Tests passes with 0 failures",
      targetFiles: ["src/Payments/WebhookHandler.cs"],
      targetDirs: ["src/Payments"],
    });
    expect(out).toContain("Done when: dotnet test src/Payments.Tests passes with 0 failures");
    expect(out).toContain("Target files/dirs: src/Payments/WebhookHandler.cs, src/Payments");
  });

  it("drops empty/whitespace-only target entries without emitting a bare line", () => {
    const out = buildItemDebateTopic(item({ id: "step3" }), {
      doneCriterion: "",
      targetFiles: ["", "  "],
      targetDirs: [],
    });
    expect(out).not.toContain("Done when:");
    expect(out).not.toContain("Target files/dirs:");
  });

  it("bounds the title, reason, done-criterion and targets to MAX_TASK_TEXT_CHARS", () => {
    const long = "x".repeat(MAX_TASK_TEXT_CHARS + 50);
    const out = buildItemDebateTopic(item({ id: "step3", title: long, reason: long }), {
      doneCriterion: long,
      targetFiles: [long],
    });
    for (const line of out.split("\n")) {
      // Every emitted field is <= MAX_TASK_TEXT_CHARS content chars plus at
      // most one trailing ellipsis + the line's own label prefix — so no
      // single line balloons anywhere near the unbounded 350-char input.
      expect(line.length).toBeLessThan(MAX_TASK_TEXT_CHARS + 60);
    }
    expect(out).toContain("…"); // boundTaskText's truncation marker fired somewhere.
  });

  it("is pure and total — never throws on an item with an empty reason", () => {
    expect(() => buildItemDebateTopic(item({ id: "step3", reason: "" }))).not.toThrow();
    const out = buildItemDebateTopic(item({ id: "step3", reason: "   " }));
    expect(out).not.toContain("Why this item was selected");
  });
});

describe("buildItemDebateFocus", () => {
  it("returns the {id, text} shape CouncilConfig.perRoundFocus expects", () => {
    const out = buildItemDebateFocus(item({ id: "step3" }));
    expect(out.id).toBe("step3");
    expect(out.text).toContain("[step3]");
  });

  it("pulls doneCriterion/targetFiles/targetDirs straight off the source task", () => {
    const out = buildItemDebateFocus(item({ id: "step3" }), {
      id: "step3",
      title: "Wire the payment webhook",
      doneCriterion: "dotnet test src/Payments.Tests passes with 0 failures",
      dependsOn: [],
      targetFiles: ["src/Payments/WebhookHandler.cs"],
      targetDirs: [],
      status: "pending",
    });
    expect(out.text).toContain("Done when: dotnet test src/Payments.Tests passes with 0 failures");
    expect(out.text).toContain("Target files/dirs: src/Payments/WebhookHandler.cs");
  });
});
