// Phase 12.1-02 — CouncilManager unit tests.
//
// Smoke-only: state isolation, resolver registration/buffering lifecycle,
// outcome parser fallback. Heavy integration is covered by
// src/council/__tests__/*.test.ts.

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { BashTool } from "../../tools/bash";
import { CouncilManager, type CouncilManagerDeps } from "../council-manager";

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
    expect(ctx).toContain("Previous Council Outcomes");
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
