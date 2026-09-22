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
  // suppressPreDebateCards / sprintPlanningMode), and — like lastSynthesis — is
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

  it("respondToQuestion reports applied:true when a live resolver consumes the answer", async () => {
    const m = new CouncilManager(makeDeps());
    const promise = m.createQuestionResponder()("qid-applied");
    const result = m.respondToQuestion("qid-applied", "answer");
    expect(result).toEqual({ applied: true, stale: false });
    await expect(promise).resolves.toBe("answer");
  });

  it("respondToQuestion reports applied:false, stale:false for a headless early-answer buffer", () => {
    const m = new CouncilManager(makeDeps());
    const result = m.respondToQuestion("qid-buffer", "early");
    expect(result).toEqual({ applied: false, stale: false });
  });
});

// Session 697419024ec8 (2026-09-22) — a gate's timeout left its resolver
// registered forever. 46 minutes later a late answer arrived, found the
// resolver still there, resolved a promise nobody was listening to any more,
// and vanished with no interaction_logs row and no debug.log line. Fixed by
// `withdrawQuestion`: it removes the resolver and records the withdrawal so a
// later `respondToQuestion` call reports it as stale instead of silently
// applying (or silently buffering) it.
describe("CouncilManager — withdrawal and stale answers (session 697419024ec8)", () => {
  it("withdrawQuestion removes the pending resolver so it never resolves again", async () => {
    const m = new CouncilManager(makeDeps());
    const pending = m.createQuestionResponder()("qid-w1");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    m.withdrawQuestion("qid-w1", "timeout");
    // The dangling promise must never resolve — there is no answer to give it.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it("a late answer to a withdrawn question is reported stale, not applied", () => {
    const m = new CouncilManager(makeDeps());
    void m.createQuestionResponder()("qid-w2");
    m.withdrawQuestion("qid-w2", "timeout");

    const result = m.respondToQuestion("qid-w2", "late-answer");
    expect(result).toEqual({ applied: false, stale: true, staleReason: "timeout" });
  });

  it("a stale answer is never buffered for a future responder to drain", async () => {
    const m = new CouncilManager(makeDeps());
    m.withdrawQuestion("qid-w3", "timeout");
    m.respondToQuestion("qid-w3", "late-answer");

    // If the answer had fallen into the headless buffer, a FUTURE responder
    // for the same id (ids are UUIDs so reuse is not expected, but the
    // contract must hold regardless) would incorrectly resolve to it.
    const responder = m.createQuestionResponder();
    const pending = responder("qid-w3");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it("a stale answer never marks wasAnsweredByCard, even when questionText is passed", () => {
    const m = new CouncilManager(makeDeps());
    void m.createQuestionResponder()("qid-w4");
    m.withdrawQuestion("qid-w4", "timeout");

    m.respondToQuestion("qid-w4", "late-answer", "What should we do?");
    const responder = m.createQuestionResponder();
    expect(responder.wasAnsweredByCard?.("qid-w4")).toBe(false);
  });

  it("withdraw is exposed on the responder created by createQuestionResponder", async () => {
    const m = new CouncilManager(makeDeps());
    const responder = m.createQuestionResponder();
    const pending = responder("qid-w5");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    expect(typeof responder.withdraw).toBe("function");
    responder.withdraw?.("qid-w5", "aborted");

    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(m.respondToQuestion("qid-w5", "too-late")).toEqual({
      applied: false,
      stale: true,
      staleReason: "aborted",
    });
  });

  it("a normal answer BEFORE any withdrawal is completely unaffected", async () => {
    const m = new CouncilManager(makeDeps());
    const pending = m.createQuestionResponder()("qid-w6");
    const result = m.respondToQuestion("qid-w6", "on-time-answer");
    expect(result).toEqual({ applied: true, stale: false });
    await expect(pending).resolves.toBe("on-time-answer");
  });

  it("_withdrawnQuestionIds is bounded (defense-in-depth, mirrors MAX_CARD_ANSWERED_IDS)", () => {
    const m = new CouncilManager(makeDeps());
    for (let i = 0; i < 250; i++) {
      m.withdrawQuestion(`qid-bulk-${i}`, "timeout");
    }
    expect(m._withdrawnCountForTests()).toBeLessThanOrEqual(200);
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
