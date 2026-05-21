/**
 * src/reporter/__tests__/auto-fire.test.ts
 *
 * B2 — Tests for reporter auto-fire observer:
 *   - sprint_stage:judgment:done emits one post
 *   - debounce blocks duplicate within 60s
 *   - disabled flag (autoFire=false) suppresses entirely
 *   - no Discord config = no-op (skip silently)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock settings module
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: vi.fn(),
}));

import { loadUserSettings } from "../../utils/settings.js";
import { __resetAutoFireDebounceForTests, type AutoFireDeps, type AutoFireEvent, maybeAutoFire } from "../auto-fire.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(channelId: string | null = "ch-123"): AutoFireDeps & { posted: string[] } {
  const posted: string[] = [];
  return {
    posted,
    chat: {
      postMessage: vi.fn(async (_channelId: string, content: string) => {
        posted.push(content);
        return { id: "msg-1" };
      }),
      createChannel: vi.fn(),
      getChannelMessages: vi.fn(),
      addChannelPermission: vi.fn(),
      getCurrentUserId: vi.fn(),
      listGuildChannels: vi.fn(),
    } as any,
    resolveChannelId: vi.fn().mockResolvedValue(channelId),
  };
}

function makeEvent(overrides: Partial<AutoFireEvent> = {}): AutoFireEvent {
  return {
    kind: "sprint-done",
    runId: "run-abc",
    flowDir: "/tmp/.planning",
    productSlug: "my-product",
    sprintN: 1,
    pct: 75,
    verdict: "pass",
    ...overrides,
  };
}

function enableAutoFire(): void {
  (loadUserSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    reporter: { autoFire: true },
  });
}

function disableAutoFire(): void {
  (loadUserSettings as ReturnType<typeof vi.fn>).mockReturnValue({
    reporter: { autoFire: false },
  });
}

function noReporterSettings(): void {
  (loadUserSettings as ReturnType<typeof vi.fn>).mockReturnValue({});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("maybeAutoFire", () => {
  beforeEach(() => {
    __resetAutoFireDebounceForTests();
  });

  it("posts when autoFire=true and Discord is configured", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent({ kind: "sprint-done", sprintN: 1, pct: 75, verdict: "pass" }), deps);
    expect(deps.posted).toHaveLength(1);
    expect(deps.posted[0]).toContain("Sprint 1 done");
    expect(deps.posted[0]).toContain("75%");
  });

  it("does not post when autoFire=false (default off)", async () => {
    disableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent(), deps);
    expect(deps.posted).toHaveLength(0);
  });

  it("does not post when reporter setting is absent (default off)", async () => {
    noReporterSettings();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent(), deps);
    expect(deps.posted).toHaveLength(0);
  });

  it("does not post when Discord channel is not configured", async () => {
    enableAutoFire();
    const deps = makeDeps(null); // no channel
    await maybeAutoFire(makeEvent(), deps);
    expect(deps.posted).toHaveLength(0);
  });

  it("debounces duplicate events within 60s for the same runId", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    // First call — should post.
    await maybeAutoFire(makeEvent({ runId: "run-debounce" }), deps);
    expect(deps.posted).toHaveLength(1);

    // Second call within 60s — should be debounced.
    await maybeAutoFire(makeEvent({ runId: "run-debounce" }), deps);
    expect(deps.posted).toHaveLength(1); // still 1
  });

  it("does NOT debounce different runIds", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent({ runId: "run-A" }), deps);
    await maybeAutoFire(makeEvent({ runId: "run-B" }), deps);
    expect(deps.posted).toHaveLength(2);
  });

  it("posts sprint-halt message with haltReason", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent({ kind: "sprint-halt", haltReason: "no_recipe", runId: "run-halt" }), deps);
    expect(deps.posted).toHaveLength(1);
    expect(deps.posted[0]).toContain("halted");
    expect(deps.posted[0]).toContain("no_recipe");
  });

  it("posts sprint-plan-committed message with sprintCount", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent({ kind: "sprint-plan-committed", sprintCount: 4, runId: "run-commit" }), deps);
    expect(deps.posted).toHaveLength(1);
    expect(deps.posted[0]).toContain("Run started");
    expect(deps.posted[0]).toContain("4 sprints");
  });

  it("uses singular 'sprint' for sprintCount=1", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    await maybeAutoFire(makeEvent({ kind: "sprint-plan-committed", sprintCount: 1, runId: "run-single" }), deps);
    expect(deps.posted[0]).toContain("1 sprint planned");
    expect(deps.posted[0]).not.toContain("1 sprints");
  });

  it("never throws even when chat.postMessage rejects", async () => {
    enableAutoFire();
    const deps = makeDeps("ch-123");
    (deps.chat.postMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    // Should not throw
    await expect(maybeAutoFire(makeEvent({ runId: "run-err" }), deps)).resolves.toBeUndefined();
  });
});
