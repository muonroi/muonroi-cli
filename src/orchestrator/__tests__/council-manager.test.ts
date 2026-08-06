// Phase 12.1-02 — CouncilManager unit tests.
//
// Smoke-only: state isolation, resolver registration/buffering lifecycle,
// outcome parser fallback. Heavy integration is covered by
// src/council/__tests__/*.test.ts.

import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import type { BashTool } from "../../tools/bash";
import { CouncilManager, type CouncilManagerDeps } from "../council-manager";
import { __resetInteractivePauseForTests, isInteractivePaused } from "../interactive-pause.js";

function makeDeps(overrides: Partial<CouncilManagerDeps> = {}): CouncilManagerDeps {
  return {
    getModelId: () => "test-model",
    getSessionId: () => null,
    hasSessionStore: () => false,
    getMessages: () => [] as ReadonlyArray<ModelMessage>,
    getBash: () => ({ getCwd: () => process.cwd() }) as unknown as BashTool,
    getMode: () => "agent",
    ...overrides,
  };
}

describe("CouncilManager — state isolation", () => {
  it("each instance owns its own stats", () => {
    const a = new CouncilManager(makeDeps());
    const b = new CouncilManager(makeDeps());
    a.resetStats(1000);
    b.resetStats(2000);
    expect(a.stats.startMs).toBe(1000);
    expect(b.stats.startMs).toBe(2000);
    // Bump a's calls — b stays at zero.
    a.stats.calls = 5;
    expect(b.stats.calls).toBe(0);
  });

  it("synthesis state is per-instance", () => {
    const a = new CouncilManager(makeDeps());
    const b = new CouncilManager(makeDeps());
    a.setLastSynthesis("from-a");
    b.setLastSynthesis("from-b");
    expect(a.lastSynthesis).toBe("from-a");
    expect(b.lastSynthesis).toBe("from-b");
  });

  // The launch-card lock (spec.intentKind, task-2) is relayed across the same
  // seam as lastPostDebateAction so the auto-council caller (tool-engine) can
  // resolve the run's authoritative kind instead of falling back to the
  // post-hoc synthesis regex (task-3). Defaults to null (no card ran yet /
  // convenePath / sprintPlanningMode), and — like lastSynthesis — is
  // per-instance state, not shared/global.
  it("locked intent kind defaults to null and is per-instance", () => {
    const a = new CouncilManager(makeDeps());
    const b = new CouncilManager(makeDeps());
    expect(a.lastIntentKind).toBeNull();
    a.setLastIntentKind("implementation_plan");
    b.setLastIntentKind("evaluation");
    expect(a.lastIntentKind).toBe("implementation_plan");
    expect(b.lastIntentKind).toBe("evaluation");
  });

  it("continuation flag is per-instance", () => {
    const a = new CouncilManager(makeDeps());
    const b = new CouncilManager(makeDeps());
    a.setContinuation(true);
    expect(a.isContinuation).toBe(true);
    expect(b.isContinuation).toBe(false);
  });
});

describe("CouncilManager — question resolver lifecycle", () => {
  it("buffers question answers that arrive before the responder registers", async () => {
    const m = new CouncilManager(makeDeps());
    m.respondToQuestion("qid-1", "buffered-answer");
    const promise = m.createQuestionResponder()("qid-1");
    await expect(promise).resolves.toBe("buffered-answer");
  });

  it("resolves a pending question when the answer arrives later", async () => {
    const m = new CouncilManager(makeDeps());
    const promise = m.createQuestionResponder()("qid-2");
    m.respondToQuestion("qid-2", "later-answer");
    await expect(promise).resolves.toBe("later-answer");
  });

  it("drains the buffered slot exactly once per question id", async () => {
    const m = new CouncilManager(makeDeps());
    m.respondToQuestion("qid-3", "first");
    await expect(m.createQuestionResponder()("qid-3")).resolves.toBe("first");
    // Second responder for the same id must wait for a new answer.
    const stalled = m.createQuestionResponder()("qid-3");
    let settled = false;
    void stalled.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    m.respondToQuestion("qid-3", "second");
    await expect(stalled).resolves.toBe("second");
  });
});

// Regression — session d22397a9e47d (2026-07-29). A council askcard blocks the
// turn on a human, but the responder parked a bare Promise without telling
// interactive-pause.ts, so the 120s turn-idle watchdog counted the human's
// reading time as "no output" and killed the turn: askcard_open 10:24:19.284 →
// error/watchdog 10:26:19.275 = 119.991s. The killed turn never reached
// appendMessages, so ~20.5 min of council work ($0.1845 metered) was discarded
// with "No assistant messages found to absorb from sub-session".
// Only the `ask_user` TOOL path was bracketed; every council card was not.
describe("CouncilManager — question wait holds the watchdog open", () => {
  beforeEach(() => __resetInteractivePauseForTests());

  it("is paused while a question card awaits a human, and released after the answer", async () => {
    const m = new CouncilManager(makeDeps());
    expect(isInteractivePaused()).toBe(false);

    const pending = m.createQuestionResponder()("qid-pause");
    expect(isInteractivePaused()).toBe(true); // human is reading the card

    m.respondToQuestion("qid-pause", "answered");
    await expect(pending).resolves.toBe("answered");
    expect(isInteractivePaused()).toBe(false);
  });

  it("does not leak a pause when the answer was already buffered", async () => {
    const m = new CouncilManager(makeDeps());
    m.respondToQuestion("qid-buffered", "early");
    await expect(m.createQuestionResponder()("qid-buffered")).resolves.toBe("early");
    expect(isInteractivePaused()).toBe(false);
  });

  it("ref-counts concurrent cards so the first answer does not un-pause the second", async () => {
    const m = new CouncilManager(makeDeps());
    const responder = m.createQuestionResponder();
    const a = responder("qid-a");
    const b = responder("qid-b");
    expect(isInteractivePaused()).toBe(true);

    m.respondToQuestion("qid-a", "ans-a");
    await expect(a).resolves.toBe("ans-a");
    expect(isInteractivePaused()).toBe(true); // qid-b still open

    m.respondToQuestion("qid-b", "ans-b");
    await expect(b).resolves.toBe("ans-b");
    expect(isInteractivePaused()).toBe(false);
  });

  it("releasePendingWaits un-pauses cards abandoned by an aborted turn", () => {
    const m = new CouncilManager(makeDeps());
    const responder = m.createQuestionResponder();
    void responder("qid-abandoned-1");
    void responder("qid-abandoned-2");
    void m.createPreflightResponder()("pf-abandoned");
    expect(isInteractivePaused()).toBe(true);

    // Nothing ever answers these — the turn was killed mid-card.
    m.releasePendingWaits();
    expect(isInteractivePaused()).toBe(false);
  });

  it("releasePendingWaits is idempotent and cannot drive the counter negative", async () => {
    const m = new CouncilManager(makeDeps());
    const pending = m.createQuestionResponder()("qid-idem");
    m.releasePendingWaits();
    m.releasePendingWaits();
    expect(isInteractivePaused()).toBe(false);

    // A late answer for an already-released card must still resolve, and must
    // not double-release into a negative counter.
    m.respondToQuestion("qid-idem", "late");
    await expect(pending).resolves.toBe("late");
    expect(isInteractivePaused()).toBe(false);

    // The gate must still work for the NEXT card.
    void m.createQuestionResponder()("qid-after");
    expect(isInteractivePaused()).toBe(true);
  });

  it("holds the watchdog open for preflight cards too", async () => {
    const m = new CouncilManager(makeDeps());
    const pending = m.createPreflightResponder()("pf-pause");
    expect(isInteractivePaused()).toBe(true);
    m.respondToPreflight("pf-pause", true);
    await expect(pending).resolves.toBe(true);
    expect(isInteractivePaused()).toBe(false);
  });
});

describe("CouncilManager — preflight resolver lifecycle", () => {
  it("buffers preflight approvals before the responder registers", async () => {
    const m = new CouncilManager(makeDeps());
    m.respondToPreflight("pf-1", false);
    await expect(m.createPreflightResponder()("pf-1")).resolves.toBe(false);
  });

  it("resolves pending preflight when approval arrives later", async () => {
    const m = new CouncilManager(makeDeps());
    const promise = m.createPreflightResponder()("pf-2");
    m.respondToPreflight("pf-2", true);
    await expect(promise).resolves.toBe(true);
  });
});

describe("CouncilManager — parseOutcome fallback", () => {
  it("returns null on non-JSON synthesis", () => {
    const m = new CouncilManager(makeDeps());
    expect(m.parseOutcome("no json here", "topic")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const m = new CouncilManager(makeDeps());
    expect(m.parseOutcome('{"type":"decision"}', "topic")).toBeNull();
    expect(m.parseOutcome('{"summary":"only summary"}', "topic")).toBeNull();
  });

  it("parses a well-formed decision outcome", () => {
    const m = new CouncilManager(makeDeps());
    const parsed = m.parseOutcome(
      '{"type":"decision","summary":"do X","agreed":["a"],"tradeoffs":[],"recommendation":"X"}',
      "topic",
    );
    expect(parsed?.type).toBe("decision");
    expect(parsed?.summary).toBe("do X");
    expect(parsed?.agreed).toEqual(["a"]);
  });
});

describe("CouncilManager — buildContext", () => {
  it("returns empty string when there are no messages", () => {
    const m = new CouncilManager(makeDeps({ getMessages: () => [] }));
    expect(m.buildContext()).toBe("");
  });

  it("includes recent user messages", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "second user turn" },
    ];
    const m = new CouncilManager(makeDeps({ getMessages: () => msgs }));
    const ctx = m.buildContext();
    expect(ctx).toContain("hello world");
    expect(ctx).toContain("second user turn");
  });

  it("surfaces previous council memories", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "[Council Memory] previous outcome" },
      { role: "user", content: "current ask" },
    ];
    const m = new CouncilManager(makeDeps({ getMessages: () => msgs }));
    const ctx = m.buildContext();
    expect(ctx).toContain("Key Decisions");
    expect(ctx).toContain("previous outcome");
  });
});

describe("CouncilManager — hasMultiProviderConfig", () => {
  it("returns false for single-provider role models", () => {
    const m = new CouncilManager(makeDeps());
    expect(m.hasMultiProviderConfig({ implement: "claude-sonnet-4-6", verify: "claude-haiku-4" })).toBe(false);
  });

  it("returns true when models span multiple providers", () => {
    const m = new CouncilManager(makeDeps());
    expect(m.hasMultiProviderConfig({ implement: "claude-sonnet-4-6", verify: "gpt-4o-mini" })).toBe(true);
  });

  it("returns false for empty config", () => {
    const m = new CouncilManager(makeDeps());
    expect(m.hasMultiProviderConfig({})).toBe(false);
  });
});
