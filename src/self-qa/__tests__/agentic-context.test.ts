import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { buildAgenticContext } from "../agentic-context.js";

const frame = (over: Partial<LiveFrame> = {}): LiveFrame => ({
  mode: "live",
  version: "0.4.0",
  seq: 1,
  ts: Date.now(),
  nodes: [
    { id: "composer", role: "textbox", name: "Prompt", value: "" },
    { id: "askcard", role: "dialog", name: "What scope?", isModal: true },
  ],
  focus: "composer",
  modals: ["askcard"],
  ...over,
});

describe("agentic-context", () => {
  it("renders askcard question + options when pinned", () => {
    const f = frame({
      nodes: [
        {
          id: "askcard",
          role: "dialog",
          name: "What scope?",
          isModal: true,
          children: [
            { id: "opt-small", role: "listitem", name: "small" },
            { id: "opt-large", role: "listitem", name: "large" },
          ],
        },
      ],
    });
    const ctx = buildAgenticContext(null, f, [], { pinIds: ["askcard"] });
    expect(ctx.prompt).toContain("Pinned nodes");
    expect(ctx.prompt).toContain("opt-small");
    expect(ctx.prompt).toContain("opt-large");
  });

  it("shows delta vs previous frame", () => {
    const prev = frame();
    const next = frame({
      seq: 2,
      focus: "askcard",
      nodes: [
        { id: "composer", role: "textbox", name: "Prompt", value: "/ideal" },
        { id: "askcard", role: "dialog", name: "What scope?", isModal: true },
      ],
    });
    const ctx = buildAgenticContext(prev, next, []);
    expect(ctx.prompt).toContain("Changed since last turn");
    expect(ctx.prompt).toContain("composer{value");
    expect(ctx.prompt).toContain("focus: composer → askcard");
  });

  it("renders event tail in newest-first order with semantic shortcuts", () => {
    const events: LiveEvent[] = [
      { t: "event", kind: "toast", level: "info", text: "saved" },
      {
        t: "event",
        kind: "askcard-open",
        questionId: "q1",
        question: "What scope?",
        phase: "scope",
        optionCount: 3,
      },
      {
        t: "event",
        kind: "route-decision",
        path: "council",
        complexity: "complex",
        forceCouncil: true,
        runId: "r1",
      },
    ];
    const ctx = buildAgenticContext(null, frame(), events);
    const idxRoute = ctx.prompt.indexOf("route-decision");
    const idxAsk = ctx.prompt.indexOf("askcard-open");
    expect(idxRoute).toBeGreaterThan(-1);
    expect(idxAsk).toBeGreaterThan(-1);
    // newest first: route-decision should appear before askcard-open
    expect(idxRoute).toBeLessThan(idxAsk);
    expect(ctx.prompt).toContain('q="What scope?"');
  });

  it("truncates when exceeding maxChars", () => {
    const events: LiveEvent[] = Array.from({ length: 100 }, (_, i) => ({
      t: "event" as const,
      kind: "toast" as const,
      level: "info" as const,
      text: `noisy event ${i} `.repeat(50),
    }));
    const ctx = buildAgenticContext(null, frame(), events, { maxChars: 500 });
    expect(ctx.truncated).toBe(true);
    expect(ctx.prompt.length).toBeLessThanOrEqual(550);
    expect(ctx.prompt).toContain("truncated");
  });

  it("estimatedTokens roughly matches chars/4", () => {
    const ctx = buildAgenticContext(null, frame(), []);
    expect(Math.abs(ctx.estimatedTokens - Math.ceil(ctx.prompt.length / 4))).toBeLessThan(2);
  });
});
