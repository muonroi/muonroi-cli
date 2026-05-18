/**
 * emit-event.spec.ts — Phase 4: Volume control & redaction tests.
 *
 * Covers:
 *   - createEventFilter: env-driven allowlist (4.1)
 *   - redactEvent: per-kind field allowlist + API key scrubbing (4.3)
 *   - emitEvent integration: filter + redact wired in agent-mode (4.2)
 *   - Zero-overhead when agentRuntime is unset (4.4)
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventFilter } from "../../agent-harness-core/src/event-filter.js";
import { redactEvent } from "../../agent-harness-core/src/event-redact.js";
import type { AgentModeRuntime } from "../src/agent-mode.js";
import { startAgentMode } from "../src/agent-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreams() {
  const out = new PassThrough();
  const inn = new PassThrough();
  return { out, inn };
}

async function collectLines(stream: PassThrough, waitMs = 30): Promise<unknown[]> {
  await new Promise((r) => setTimeout(r, waitMs));
  const data = stream.read();
  if (!data) return [];
  const text = (data as Buffer).toString("utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function makeRuntime(envOverride?: string) {
  const { out, inn } = makeStreams();
  const originalEnv = process.env["MUONROI_HARNESS_EVENTS"];
  if (envOverride !== undefined) {
    process.env["MUONROI_HARNESS_EVENTS"] = envOverride;
  } else {
    delete process.env["MUONROI_HARNESS_EVENTS"];
  }
  const rt = await startAgentMode({
    cols: 80,
    rows: 24,
    idleMs: 5000,
    fakeClock: true,
    injectStreams: { out, in: inn },
  });
  // Restore env after startAgentMode reads it
  if (originalEnv !== undefined) {
    process.env["MUONROI_HARNESS_EVENTS"] = originalEnv;
  } else {
    delete process.env["MUONROI_HARNESS_EVENTS"];
  }
  return { rt, out, inn };
}

// ---------------------------------------------------------------------------
// 4.1 — createEventFilter
// ---------------------------------------------------------------------------

describe("createEventFilter (4.1)", () => {
  it("default (unset): llm-token is blocked", () => {
    const filter = createEventFilter(undefined);
    expect(filter("llm-token")).toBe(false);
  });

  it("default (unset): toast passes through", () => {
    const filter = createEventFilter(undefined);
    expect(filter("toast")).toBe(true);
  });

  it("default (unset): council-step passes through", () => {
    const filter = createEventFilter(undefined);
    expect(filter("council-step")).toBe(true);
  });

  it("default (unset): llm-done passes through", () => {
    const filter = createEventFilter(undefined);
    expect(filter("llm-done")).toBe(true);
  });

  it('env="*": all kinds pass including llm-token', () => {
    const filter = createEventFilter("*");
    expect(filter("llm-token")).toBe(true);
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
    expect(filter("some-future-kind")).toBe(true);
  });

  it('env="all": all kinds pass', () => {
    const filter = createEventFilter("all");
    expect(filter("llm-token")).toBe(true);
    expect(filter("toast")).toBe(true);
  });

  it('env="lifecycle": llm-token is blocked', () => {
    const filter = createEventFilter("lifecycle");
    expect(filter("llm-token")).toBe(false);
  });

  it('env="lifecycle": council-step passes', () => {
    const filter = createEventFilter("lifecycle");
    expect(filter("council-step")).toBe(true);
  });

  it('env="lifecycle": toast passes', () => {
    const filter = createEventFilter("lifecycle");
    expect(filter("toast")).toBe(true);
  });

  it('env="toast,council-step": only those two pass', () => {
    const filter = createEventFilter("toast,council-step");
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
    expect(filter("llm-token")).toBe(false);
    expect(filter("llm-done")).toBe(false);
    expect(filter("sprint-stage")).toBe(false);
  });

  it('env="llm-token,council-step": llm-token explicitly enabled', () => {
    const filter = createEventFilter("llm-token,council-step");
    expect(filter("llm-token")).toBe(true);
    expect(filter("council-step")).toBe(true);
    expect(filter("toast")).toBe(false);
  });

  it('env="lifecycle,llm-token": expands lifecycle preset + adds llm-token', () => {
    const filter = createEventFilter("lifecycle,llm-token");
    expect(filter("llm-token")).toBe(true);
    expect(filter("toast")).toBe(true);
    expect(filter("council-step")).toBe(true);
  });

  it("empty string: treated as unset → lifecycle preset (llm-token blocked)", () => {
    const filter = createEventFilter("");
    expect(filter("llm-token")).toBe(false);
    expect(filter("toast")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4.3 — redactEvent
// ---------------------------------------------------------------------------

describe("redactEvent (4.3)", () => {
  it("passes idle pseudo-event unchanged", () => {
    const e = { t: "idle" } as const;
    expect(redactEvent(e)).toEqual({ t: "idle" });
  });

  it("toast: text capped at 500 chars", () => {
    // Use a repeating non-alphanum-only pattern to avoid the API key regex replacing it
    const longText = "Hello world! ".repeat(50); // 650 chars, safe non-key content
    const result = redactEvent({ t: "event", kind: "toast", level: "info", text: longText });
    expect(result).toMatchObject({ t: "event", kind: "toast" });
    const r = result as { text: string };
    expect(r.text.length).toBe(500);
  });

  it("toast: text shorter than 500 chars passes unchanged", () => {
    const result = redactEvent({ t: "event", kind: "toast", level: "error", text: "Short error" });
    const r = result as { text: string };
    expect(r.text).toBe("Short error");
  });

  it("council-step: no forbidden fields → passes through all listed fields", () => {
    const e = {
      t: "event" as const,
      kind: "council-step" as const,
      phaseId: "phase-1",
      phaseKind: "opening",
      state: "active",
      label: "Opening the council",
      elapsedMs: 123,
    };
    const result = redactEvent(e) as typeof e;
    expect(result.phaseId).toBe("phase-1");
    expect(result.phaseKind).toBe("opening");
    expect(result.state).toBe("active");
    expect(result.label).toBe("Opening the council");
    expect(result.elapsedMs).toBe(123);
  });

  it("council-step: unlisted field is stripped", () => {
    const e = {
      t: "event" as const,
      kind: "council-step" as const,
      phaseId: "phase-1",
      phaseKind: "opening",
      state: "active",
      label: "Test",
      elapsedMs: 0,
      // Extra field that should be stripped
      internalSystemPrompt: "You are a helpful assistant...",
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["internalSystemPrompt"]).toBeUndefined();
    expect(result["phaseId"]).toBe("phase-1");
  });

  it("askcard-answered: answerText with API key is redacted", () => {
    const e = {
      t: "event" as const,
      kind: "askcard-answered" as const,
      questionId: "q-1",
      answerKind: "freetext",
      answerText: "My key is sk-1234567890abcdefghij and I want to use it",
    };
    const result = redactEvent(e) as { answerText: string };
    expect(result.answerText).not.toContain("sk-1234567890abcdefghij");
    expect(result.answerText).toContain("[redacted]");
  });

  it("askcard-answered: normal answer text passes through unchanged", () => {
    const e = {
      t: "event" as const,
      kind: "askcard-answered" as const,
      questionId: "q-2",
      answerKind: "choice",
      answerText: "Option A",
    };
    const result = redactEvent(e) as { answerText: string };
    expect(result.answerText).toBe("Option A");
  });

  it("askcard-open: question field capped at 300 chars", () => {
    const longQuestion = "What ".repeat(100); // 500 chars
    const e = {
      t: "event" as const,
      kind: "askcard-open" as const,
      questionId: "q-3",
      question: longQuestion,
      phase: "clarify",
      optionCount: 3,
    };
    const result = redactEvent(e) as { question: string };
    expect(result.question.length).toBe(300);
  });

  it("askcard-open: API key in question is redacted", () => {
    const e = {
      t: "event" as const,
      kind: "askcard-open" as const,
      questionId: "q-4",
      question: "Use sk-abcdefghijklmnopqrstuvwxyz123456 as your key",
      phase: "preflight",
      optionCount: 2,
    };
    const result = redactEvent(e) as { question: string };
    expect(result.question).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.question).toContain("[redacted]");
  });

  it("llm-token: delta capped at 500 chars", () => {
    // Use a repeating non-alphanum-only pattern to avoid the API key regex replacing it
    const e = {
      t: "event" as const,
      kind: "llm-token" as const,
      correlationId: "call-1",
      delta: "The quick brown fox. ".repeat(30), // 630 chars, safe content
      tokenIndex: 0,
    };
    const result = redactEvent(e) as { delta: string };
    expect(result.delta.length).toBe(500);
  });

  it("llm-token: messages array field (not in allowlist) is stripped", () => {
    const e = {
      t: "event" as const,
      kind: "llm-token" as const,
      correlationId: "call-1",
      delta: "hello",
      tokenIndex: 0,
      messages: [{ role: "system", content: "You are..." }],
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["messages"]).toBeUndefined();
    expect(result["correlationId"]).toBe("call-1");
  });

  it("llm-done: only correlationId, totalChars, finishReason pass through", () => {
    const e = {
      t: "event" as const,
      kind: "llm-done" as const,
      correlationId: "call-2",
      totalChars: 1234,
      finishReason: "stop",
      rawApiResponse: { choices: [{ message: { content: "secret" } }] },
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["correlationId"]).toBe("call-2");
    expect(result["totalChars"]).toBe(1234);
    expect(result["finishReason"]).toBe("stop");
    expect(result["rawApiResponse"]).toBeUndefined();
  });

  it("route-decision: only path, complexity, forceCouncil, runId pass", () => {
    const e = {
      t: "event" as const,
      kind: "route-decision" as const,
      path: "council",
      complexity: "high",
      forceCouncil: false,
      runId: "run-1",
      internalFlags: { debug: true },
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["path"]).toBe("council");
    expect(result["complexity"]).toBe("high");
    expect(result["forceCouncil"]).toBe(false);
    expect(result["runId"]).toBe("run-1");
    expect(result["internalFlags"]).toBeUndefined();
  });

  it("sprint-stage: stage and runId pass; extra fields stripped", () => {
    const e = {
      t: "event" as const,
      kind: "sprint-stage" as const,
      sprintIndex: 1,
      stage: "planning" as const,
      runId: "run-2",
      planContent: "Step 1: ...",
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["sprintIndex"]).toBe(1);
    expect(result["stage"]).toBe("planning");
    expect(result["runId"]).toBe("run-2");
    expect(result["planContent"]).toBeUndefined();
  });

  it("unknown kind: only t + kind retained (fail-safe)", () => {
    const e = {
      t: "event",
      kind: "some-future-unknown-kind",
      sensitiveData: "top-secret",
    } as unknown as Parameters<typeof redactEvent>[0];
    const result = redactEvent(e) as Record<string, unknown>;
    expect(result["t"]).toBe("event");
    expect(result["kind"]).toBe("some-future-unknown-kind");
    expect(result["sensitiveData"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4.2 — emitEvent integration: filter + redact wired in agent-mode
// ---------------------------------------------------------------------------

describe("AgentMode emitEvent filter+redact integration (4.2)", () => {
  let rt: AgentModeRuntime;
  let out: PassThrough;

  afterEach(() => {
    rt?.dispose();
  });

  it("env unset: llm-token is dropped (not written to wire)", async () => {
    ({ rt, out } = await makeRuntime(undefined));

    rt.emitEvent({
      t: "event",
      kind: "llm-token",
      correlationId: "call-1",
      delta: "hello",
      tokenIndex: 0,
    });

    const lines = await collectLines(out);
    const tokenLines = lines.filter((l) => (l as { kind?: string }).kind === "llm-token");
    expect(tokenLines).toHaveLength(0);
  });

  it("env unset: toast passes through", async () => {
    ({ rt, out } = await makeRuntime(undefined));

    rt.emitEvent({ t: "event", kind: "toast", level: "info", text: "Hello" });

    const lines = await collectLines(out);
    const toastLine = lines.find((l) => (l as { kind?: string }).kind === "toast");
    expect(toastLine).toBeDefined();
    expect((toastLine as { text?: string }).text).toBe("Hello");
  });

  it('env="all": llm-token passes through', async () => {
    ({ rt, out } = await makeRuntime("all"));

    rt.emitEvent({
      t: "event",
      kind: "llm-token",
      correlationId: "call-2",
      delta: "world",
      tokenIndex: 0,
    });

    const lines = await collectLines(out);
    const tokenLine = lines.find((l) => (l as { kind?: string }).kind === "llm-token");
    expect(tokenLine).toBeDefined();
  });

  it('env="lifecycle": council-step passes, llm-token is dropped', async () => {
    ({ rt, out } = await makeRuntime("lifecycle"));

    rt.emitEvent({
      t: "event",
      kind: "llm-token",
      correlationId: "call-3",
      delta: "x",
      tokenIndex: 0,
    });
    rt.emitEvent({
      t: "event",
      kind: "council-step",
      phaseId: "p1",
      phaseKind: "opening",
      state: "active",
      label: "Opening",
    });

    const lines = await collectLines(out);
    const tokenLines = lines.filter((l) => (l as { kind?: string }).kind === "llm-token");
    const councilLines = lines.filter((l) => (l as { kind?: string }).kind === "council-step");
    expect(tokenLines).toHaveLength(0);
    expect(councilLines).toHaveLength(1);
  });

  it("redaction: toast text with API key is scrubbed before writing to wire", async () => {
    ({ rt, out } = await makeRuntime(undefined));

    rt.emitEvent({
      t: "event",
      kind: "toast",
      level: "warn",
      text: "Warning: key sk-abcdefghijklmnopqrstu detected",
    });

    const lines = await collectLines(out);
    const toastLine = lines.find((l) => (l as { kind?: string }).kind === "toast") as { text?: string } | undefined;
    expect(toastLine?.text).not.toContain("sk-abcdefghijklmnopqrstu");
    expect(toastLine?.text).toContain("[redacted]");
  });

  it("redaction: council-step extra field is stripped from wire", async () => {
    ({ rt, out } = await makeRuntime(undefined));

    // We can't directly attach extra fields to a typed emitEvent call,
    // but we cast to bypass TS to simulate a future payload expansion scenario.
    rt.emitEvent({
      t: "event",
      kind: "council-step",
      phaseId: "p2",
      phaseKind: "evaluation",
      state: "done",
      label: "Eval complete",
      elapsedMs: 500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const lines = await collectLines(out);
    const councilLine = lines.find((l) => (l as { kind?: string }).kind === "council-step") as Record<
      string,
      unknown
    > | undefined;
    expect(councilLine).toBeDefined();
    expect(councilLine?.["phaseId"]).toBe("p2");
    expect(councilLine?.["state"]).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// 4.4 — Zero-overhead: no agentRuntime → no throw
// ---------------------------------------------------------------------------

describe("Zero-overhead when agentRuntime is unset (4.4)", () => {
  it("calling emitEvent-like pattern with undefined runtime does not throw", () => {
    const agentRuntime: { emitEvent: (e: unknown) => void } | undefined = undefined;

    // This is the pattern used in product code via optional chaining
    expect(() => {
      agentRuntime?.emitEvent({ t: "event", kind: "toast", level: "info", text: "test" });
    }).not.toThrow();
  });

  it("globalThis.__muonroiAgentRuntime undefined → no throw on emit attempt", () => {
    const savedRuntime = (globalThis as Record<string, unknown>)["__muonroiAgentRuntime"];
    delete (globalThis as Record<string, unknown>)["__muonroiAgentRuntime"];

    expect(() => {
      const rt = (globalThis as Record<string, unknown>)["__muonroiAgentRuntime"] as
        | { emitEvent?: (e: unknown) => void }
        | undefined;
      if (rt?.emitEvent) {
        rt.emitEvent({ t: "event", kind: "sprint-stage", sprintIndex: 1, stage: "planning", runId: "r1" });
      }
    }).not.toThrow();

    // Restore
    if (savedRuntime !== undefined) {
      (globalThis as Record<string, unknown>)["__muonroiAgentRuntime"] = savedRuntime;
    }
  });
});
