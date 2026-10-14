import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F1 — an Experience-Engine feedback nag was being written into the verify
 * agent's OUTPUT stream, i.e. into a payload that is parsed for a verdict.
 *
 * Measured, run `mttwpmu8ee5b`. `sprints/1-verify.md` opens:
 *
 *     # Sprint 1 verify — UNKNOWN (score 0.00)
 *     I'll run the local verification pass … probing the host environment…
 *     ↳ 6 unrated EE recall(s) — rate the one(s) you acted on when convenient…
 *     ↳ 6 earlier EE hint(s) still unrated — rate the one(s) you acted on…
 *       - [0b0059f4-8cac-eed6-d05d-380bc433fa2e experience-principles]
 *
 * The chain: `hooks/index.ts` puts the nag in the PreToolUse hook's
 * `additionalContexts`; the tool engine yields each of those as a `content`
 * chunk; `sprint-runner.buildVerifyAgent` concatenates EVERY `content` chunk
 * into the string `parseVerifyResult` (and `sprints/<n>-verify.md`) reads.
 *
 * The boundary is declared at the ONE place that knows the stream is
 * machine-read (the verify agent) and enforced at the EMITTERS, so the nag is
 * never built. Filtering it out downstream would leave the feature writing into
 * a channel it has no business in, and the next notice added would leak again.
 */

import {
  beginRecallNagSuppression,
  isRecallNagSuppressed,
  RECALL_NAG_SENTINEL,
  sessionRecallLedger,
} from "../../ee/recall-ledger.js";

describe("recall-nag suppression scope", () => {
  it("is off by default and on inside a scope", () => {
    expect(isRecallNagSuppressed()).toBe(false);
    const release = beginRecallNagSuppression();
    expect(isRecallNagSuppressed()).toBe(true);
    release();
    expect(isRecallNagSuppressed()).toBe(false);
  });

  it("nests — an inner release does not re-open the outer scope", () => {
    const outer = beginRecallNagSuppression();
    const inner = beginRecallNagSuppression();
    inner();
    expect(isRecallNagSuppressed()).toBe(true);
    outer();
    expect(isRecallNagSuppressed()).toBe(false);
  });

  it("release is idempotent — a double release cannot cancel someone else's scope", () => {
    const a = beginRecallNagSuppression();
    const b = beginRecallNagSuppression();
    a();
    a();
    a();
    expect(isRecallNagSuppressed()).toBe(true);
    b();
    expect(isRecallNagSuppressed()).toBe(false);
  });
});

// ── Emitter pin: the PreToolUse hook honours the scope ────────────────────────

import { executeEventHooks, resetHookState } from "../../hooks/index.js";

vi.mock("../../ee/intercept.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ee/intercept.js")>();
  return {
    ...actual,
    interceptWithDefaults: vi.fn(async () => ({ decision: "allow", matches: [], suggestions: [] })),
  };
});

describe("hooks/index.ts emitter — the nag is not BUILT on a machine-read turn", () => {
  beforeEach(() => {
    resetHookState();
    sessionRecallLedger.reset();
    sessionRecallLedger.record(
      [{ id: "0b0059f4-8cac-eed6-d05d-380bc433fa2e", collection: "experience-principles" }],
      "some recall query",
    );
  });

  afterEach(() => {
    sessionRecallLedger.reset();
    resetHookState();
  });

  async function fire(): Promise<string[]> {
    const res = await executeEventHooks(
      {
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        tool_input: { command: "echo hi" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );
    return res.additionalContexts ?? [];
  }

  it("emits the nag on an ordinary turn", async () => {
    const contexts = await fire();
    expect(contexts.join("\n")).toContain(RECALL_NAG_SENTINEL);
  });

  it("emits NO nag while a machine-read scope is open", async () => {
    const release = beginRecallNagSuppression();
    try {
      const contexts = await fire();
      expect(contexts.join("\n")).not.toContain(RECALL_NAG_SENTINEL);
    } finally {
      release();
    }
  });
});

// ── Call-site pin: sprint-runner's verify agent opens the scope ───────────────

vi.mock("../../council/index.js", () => ({ runCouncil: vi.fn() }));
vi.mock("../../verify/orchestrator.js", () => ({ runVerifyOrchestration: vi.fn() }));
vi.mock("../done-gate.js", () => ({ evaluateDoneGate: vi.fn() }));
vi.mock("../circuit-breakers.js", () => ({
  CB2_oscillation: vi.fn(() => ({ halt: false, delta_t: 0, delta_t_minus_1: 0 })),
  CB3_verifyBlank: vi.fn(() => ({ halt: false })),
}));
vi.mock("../artifact-io.js", () => ({ appendIteration: vi.fn(), readCriteria: vi.fn(async () => []) }));
vi.mock("../../flow/artifact-io.js", () => ({
  readArtifact: vi.fn(async () => null),
  writeArtifact: vi.fn(async () => undefined),
}));
vi.mock("../phase-tracker-bridge.js", () => ({ postSprintBoundary: vi.fn(async () => undefined) }));
vi.mock("../role-memory.js", () => ({ appendRoleMemory: vi.fn(async () => undefined) }));
vi.mock("../../usage/ledger.js", () => ({
  commitToProduct: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
}));
vi.mock("../cost-scoper.js", () => ({
  recordProductSpend: vi.fn(async () => undefined),
}));
vi.mock("../../providers/runtime.js", () => ({ detectProviderForModel: vi.fn(() => "anthropic") }));

import { runCouncil } from "../../council/index.js";
import { isUnattendedTurn } from "../../orchestrator/unattended-turn.js";
import { runVerifyOrchestration } from "../../verify/orchestrator.js";
import { CB2_oscillation, CB3_verifyBlank } from "../circuit-breakers.js";
import { evaluateDoneGate } from "../done-gate.js";
import { runSprint } from "../sprint-runner.js";
import type { ProductSpec, RoleSlot } from "../types.js";
import { VERIFY_PASS_MARKER } from "../verify-result.js";

const NO_ROLES = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();

describe("sprint-runner call site — the verify turn declares itself machine-read", () => {
  let flowDir: string;
  let projectCwd: string;
  /** Sampled INSIDE the verify turn's own stream, which is what matters. */
  let suppressedDuringVerify: boolean | null;
  /**
   * Same sampling, for the no-human boundary. `ask_user` must not be reachable
   * from the verify turn: measured, run `muc2joffe506` sprint 2 called it at
   * 14:50:21.922Z and the card was answered 10.5 HOURS later, after the stage's
   * 600s budget had already recorded `verify: "ERROR"`.
   */
  let unattendedDuringVerify: boolean | null;

  function makeSpec(): ProductSpec {
    return {
      idea: "test idea",
      persona: "users",
      mvp: ["feat1"],
      phase2: [],
      architecture: "arch",
      ioContract: "io",
      folderStructure: "src/",
      sprintEstimate: 1,
      costEstimate: 10,
      createdAt: new Date(),
    };
  }

  async function drain<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R | undefined> {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return value as R;
    }
  }

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), "nag-flow-"));
    projectCwd = mkdtempSync(join(tmpdir(), "nag-cwd-"));
    suppressedDuringVerify = null;
    unattendedDuringVerify = null;
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (CB2_oscillation as any).mockReturnValue({ halt: false, delta_t: 0, delta_t_minus_1: 0 });
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (CB3_verifyBlank as any).mockReturnValue({ halt: false });
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (evaluateDoneGate as any).mockResolvedValue({ pass: true, score: 1.0 });
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runCouncil as any).mockImplementation(async function* () {
      yield { type: "content", content: "council planning..." };
      return "synthesis text from council";
    });
    // The REAL verify agent object sprint-runner built is handed to the
    // orchestrator, so calling through it exercises the production closure
    // (buildVerifyAgent.runTaskRequest) rather than a stand-in.
    // biome-ignore lint/suspicious/noExplicitAny: vitest mock handle
    (runVerifyOrchestration as any).mockImplementation(async (agent: any) => {
      const r = await agent.runTaskRequest({ agent: "verify", description: "d", prompt: "verify please" });
      return { ...r, verifyRecipe: { testCommands: ["npm test"], coverage: 80, shellInitCommands: [] } };
    });
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("suppression is ON while the verify turn streams, and OFF again afterwards", async () => {
    const ctx = {
      runId: "run-nag",
      flowDir,
      cwd: projectCwd,
      idea: "test idea",
      llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      processMessageFn: vi.fn(async function* (prompt: string) {
        if (prompt.includes("verify please")) {
          suppressedDuringVerify = isRecallNagSuppressed();
          unattendedDuringVerify = isUnattendedTurn();
          yield { type: "content", content: `ran the gates\n${VERIFY_PASS_MARKER}\n` };
          return;
        }
        yield { type: "content", content: "implementing..." };
      }),
      detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    };

    await drain(
      // biome-ignore lint/suspicious/noExplicitAny: runSprint takes the full loop ctx shape
      runSprint({ sprintN: 1, ctx: ctx as any, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(suppressedDuringVerify).toBe(true);
    // The scope is per-turn, not sticky: a leaked scope would silently mute the
    // nag for the rest of the session, which is a different bug.
    expect(isRecallNagSuppressed()).toBe(false);
    // The verify turn is also declared UNATTENDED, so `createBuiltinTools` leaves
    // `ask_user` out of its tool set (registry.ts).
    expect(unattendedDuringVerify).toBe(true);
    // A leaked unattended scope would strip `ask_user` from every later chat turn.
    expect(isUnattendedTurn()).toBe(false);
  }, 90_000);

  it("releases the scope even when the verify stream throws", async () => {
    const boom = new Error("stream died mid-turn");
    const ctx = {
      runId: "run-nag-throw",
      flowDir,
      cwd: projectCwd,
      idea: "test idea",
      llm: { generate: vi.fn(async () => "synthesis text"), research: vi.fn(async () => "research") },
      flags: { maxCost: 100, maxSprints: 5, doneThreshold: 0.9 },
      respondToQuestion: vi.fn(),
      respondToPreflight: vi.fn(),
      processMessageFn: vi.fn(async function* (prompt: string) {
        if (prompt.includes("verify please")) {
          throw boom;
        }
        yield { type: "content", content: "implementing..." };
      }),
      detectVerifyRecipe: vi.fn(async () => ({ testCommands: ["npm test"], coverage: 80, shellInitCommands: [] })),
    };

    await drain(
      // biome-ignore lint/suspicious/noExplicitAny: runSprint takes the full loop ctx shape
      runSprint({ sprintN: 1, ctx: ctx as any, productSpec: makeSpec(), roleAssignments: NO_ROLES, history: [] }),
    );

    expect(isRecallNagSuppressed()).toBe(false);
    expect(isUnattendedTurn()).toBe(false);
  }, 90_000);
});
