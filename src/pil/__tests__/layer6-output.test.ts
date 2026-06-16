import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPilSuffix,
  getResponseToolSet,
  isImplementationIntent,
  isQuestionLike,
  layer6Output,
} from "../layer6-output.js";
import type { OutputStyle, PipelineContext, TaskType } from "../types.js";

// Mock bridge for PIL-03 classifyViaBrain tests
vi.mock("../../ee/bridge.js", () => ({
  classifyViaBrain: vi.fn().mockResolvedValue(null),
}));

async function getMockBrain() {
  const { classifyViaBrain } = await import("../../ee/bridge.js");
  return vi.mocked(classifyViaBrain);
}

const makeCtx = (taskType: TaskType | null = null, outputStyle: OutputStyle | null = null): PipelineContext => ({
  raw: "test prompt for output style detection",
  enriched: "test prompt for output style detection",
  taskType,
  domain: null,
  confidence: 0,
  outputStyle,
  tokenBudget: 500,
  metrics: null,
  layers: [],
});

describe("applyPilSuffix — per-task-type suffixes", () => {
  const taskTypes: TaskType[] = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];

  it.each(taskTypes)("appends correct OUTPUT RULES for taskType=%s", (tt) => {
    const ctx = makeCtx(tt);
    const result = applyPilSuffix("SYSTEM", ctx);
    expect(result).toContain("SYSTEM");
    expect(result).toContain(`OUTPUT RULES (${tt})`);
    expect(result.length).toBeGreaterThan("SYSTEM".length);
  });

  it("each task type has a distinct suffix", () => {
    const suffixes = taskTypes.map((tt) => applyPilSuffix("", makeCtx(tt)));
    const unique = new Set(suffixes);
    expect(unique.size).toBe(taskTypes.length);
  });

  it("returns system prompt unchanged when taskType is null", () => {
    const system = "You are a helpful assistant.";
    expect(applyPilSuffix(system, makeCtx(null))).toBe(system);
  });

  it("defaults to concise when outputStyle is null", () => {
    const ctxNullStyle = makeCtx("debug", null);
    const ctxConcise = makeCtx("debug", "concise");
    expect(applyPilSuffix("S", ctxNullStyle)).toBe(applyPilSuffix("S", ctxConcise));
  });

  it("PIL-04 Tier 1.2: appends OUTPUT BUDGET hint per task type", () => {
    const result = applyPilSuffix("S", makeCtx("debug", "concise"));
    expect(result).toMatch(/OUTPUT BUDGET: aim for ≤500 tokens/);
    const genResult = applyPilSuffix("S", makeCtx("generate", "concise"));
    expect(genResult).toMatch(/OUTPUT BUDGET: aim for ≤1200 tokens/);
  });

  it("PIL-04 Tier 1.3: appends FORBIDDEN OPENERS rule for all styles", () => {
    for (const style of ["concise", "balanced", "detailed"] as OutputStyle[]) {
      const result = applyPilSuffix("S", makeCtx("plan", style));
      expect(result).toMatch(/FORBIDDEN OPENERS/);
      expect(result).toMatch(/Tôi sẽ/); // bilingual
    }
  });

  it("de-robotized: NO_PREAMBLE bans only openers, not end-of-turn summary or inter-tool narration", () => {
    // The summary + inter-tool bans were removed because they stripped natural
    // connective tissue (the "máy móc" feel). Inter-tool spam is still removed
    // structurally by stripInterToolNarration() in reasoning.ts. This guards
    // against the bans silently creeping back into the system prompt.
    const result = applyPilSuffix("S", makeCtx("debug", "concise"));
    expect(result).toMatch(/FORBIDDEN OPENERS/);
    expect(result).not.toMatch(/FORBIDDEN END-OF-TURN SUMMARY/);
    expect(result).not.toMatch(/FORBIDDEN INTER-TOOL NARRATION/);
  });

  it("de-robotized: debug suffix is guidance, not a rigid arrow skeleton", () => {
    // "Format = Hypothesis → Root cause → Fix → Verify" produced stilted,
    // label-prefixed answers. It must read as guidance now.
    const result = applyPilSuffix("S", makeCtx("debug", "concise"));
    expect(result).toContain("OUTPUT RULES (debug)");
    expect(result).not.toMatch(/Format = Hypothesis/);
  });

  it("E: appends the anti-bookkeeping note on the natural path for non-question turns", () => {
    // The contract's REPORTING rule leaks as a provenance footer ("evidence only
    // from this turn") on imperative answer turns; the natural path now guards it.
    const result = applyPilSuffix("S", makeCtx("analyze", "concise"));
    expect(result).toMatch(/WRITE FOR THE READER/);
    expect(result).toMatch(/provenance/i);
  });

  it("E: skips the anti-bookkeeping note for question turns (L4 QUESTION directive covers them)", () => {
    const ctx: PipelineContext = { ...makeCtx("analyze", "concise"), raw: "why does the enrichment layer fail?" };
    expect(applyPilSuffix("S", ctx)).not.toMatch(/WRITE FOR THE READER/);
  });

  it("E: response-tools path does not add the natural-path bookkeeping note", () => {
    const result = applyPilSuffix("S", makeCtx("analyze", "balanced"), true);
    expect(result).not.toMatch(/WRITE FOR THE READER/);
  });

  it("PIL-04: response-tools path skips budget+preamble (tool already enforces structure)", () => {
    const result = applyPilSuffix("S", makeCtx("analyze", "balanced"), true);
    expect(result).toContain("respond_analyze");
    expect(result).not.toMatch(/OUTPUT BUDGET/);
    expect(result).not.toMatch(/FORBIDDEN OPENERS/);
  });

  it("general response-tool turn appends the human-UX note + no-footer clause (session 9e3fb3e2e0c9)", () => {
    // A general/question response-tool turn must steer the answer toward a
    // human reader: lead with the answer, no implementation plan, no process
    // narration, and crucially NO evidence-provenance footer ("all facts from
    // this turn / did not infer unopened files") — that compliance bookkeeping
    // leaked into the user-facing reply.
    const result = applyPilSuffix("S", makeCtx("general", "concise"), true);
    expect(result).toContain("respond_general");
    expect(result).toMatch(/for the HUMAN who asked/);
    expect(result).toMatch(/do NOT narrate your own process/);
    expect(result).toMatch(/Do NOT append an evidence-provenance footer/);
  });
});

describe("getResponseToolSet — narrow gating (de-robotizing)", () => {
  // Override raw on a typed ctx so the report/question discriminator is exercised.
  const ctxRaw = (raw: string, t: TaskType) => ({ ...makeCtx(t, null), raw });

  it("returns response tool for analyze on an explicit report/list request", () => {
    const tools = getResponseToolSet(ctxRaw("audit the orchestrator and list all cost-leak findings", "analyze"));
    expect(Object.keys(tools)).toContain("respond_analyze");
  });

  it("returns response tool for plan on an explicit plan request", () => {
    const tools = getResponseToolSet(ctxRaw("plan the migration to the new auth flow step by step", "plan"));
    expect(Object.keys(tools)).toContain("respond_plan");
  });

  it("returns response tool for debug only on an explicit report request", () => {
    const tools = getResponseToolSet(ctxRaw("audit the failing suite and list each root cause", "debug"));
    expect(Object.keys(tools)).toContain("respond_debug");
  });

  it("returns empty toolset for generate (code-heavy, markdown wins)", () => {
    expect(getResponseToolSet(makeCtx("generate", null))).toEqual({});
  });

  it("returns empty toolset for refactor (diff-heavy, markdown wins)", () => {
    expect(getResponseToolSet(makeCtx("refactor", null))).toEqual({});
  });

  it("returns empty toolset for documentation (prose-heavy)", () => {
    expect(getResponseToolSet(makeCtx("documentation", null))).toEqual({});
  });

  it("returns response tool for general regardless of report signal (renders as plain markdown)", () => {
    // general is exempt from the report/question gate: GeneralSchema is pure text
    // and its renderer shows plain markdown, so respond_general is never robotic.
    const tools = getResponseToolSet(makeCtx("general", null));
    expect(Object.keys(tools)).toContain("respond_general");
  });

  it("drops respond_general when providerId is deepseek (token leak quirk)", () => {
    expect(getResponseToolSet(makeCtx("general", null), "deepseek")).toEqual({});
    expect(getResponseToolSet(makeCtx("general", null), "siliconflow")).toEqual({});
  });

  it("keeps respond_general for openai/anthropic/google", () => {
    for (const id of ["openai", "anthropic", "google", "xai"] as const) {
      const tools = getResponseToolSet(makeCtx("general", null), id);
      expect(Object.keys(tools)).toContain("respond_general");
    }
  });

  it("returns empty toolset when taskType is null", () => {
    expect(getResponseToolSet(makeCtx(null, null))).toEqual({});
  });

  it("gates the response tool for chitchat turns", () => {
    const ctx: PipelineContext = { ...makeCtx("general", null), intentKind: "chitchat" };
    expect(getResponseToolSet(ctx)).toEqual({});
  });

  it("DROPS respond_<task> for question-style debug/analyze/plan (natural markdown path)", () => {
    // The de-robotizing change: a plain QUESTION must not be forced into the
    // rigid respond_* schema + labeled renderer. It falls through to the softened
    // markdown OUTPUT RULES so the answer reads as natural prose.
    expect(getResponseToolSet(ctxRaw("why does the build fail intermittently?", "debug"))).toEqual({});
    expect(getResponseToolSet(ctxRaw("analyze how the enrichment function works", "analyze"))).toEqual({});
    expect(getResponseToolSet(ctxRaw("what is the cleanest way to structure this module?", "plan"))).toEqual({});
  });

  it("KEEPS respond_<task> for explicit report / list / plan requests (EN + VI)", () => {
    const keep = (raw: string, t: TaskType) => Object.keys(getResponseToolSet(ctxRaw(raw, t)));
    expect(keep("list all cost leaks in the orchestrator", "analyze")).toContain("respond_analyze");
    expect(keep("review the module and report each finding by severity", "analyze")).toContain("respond_analyze");
    expect(keep("lập kế hoạch migration sang auth flow mới", "plan")).toContain("respond_plan");
  });

  it("DROPS respond_<task> for a QUESTION that merely mentions plan/list (narrow-gate fix)", () => {
    // Live bug (grok interview): a question that QUOTED the phrase "state a 2-3
    // line plan" matched the bare word 'plan' in STRUCTURED_REPORT_RE and forced
    // respond_plan, cramming an introspective answer into a rigid plan schema. A
    // question-shaped prompt must stay on the natural markdown path even when it
    // contains plan/list words.
    expect(
      getResponseToolSet(ctxRaw("what rules constrain you, e.g. the 'state a 2-3 line plan' directive?", "plan")),
    ).toEqual({});
    expect(getResponseToolSet(ctxRaw("can you list the main points?", "analyze"))).toEqual({});
    expect(getResponseToolSet(ctxRaw("how would you plan the rollout?", "plan"))).toEqual({});
    // Imperative delivery requests are NOT question-shaped → still structured.
    expect(Object.keys(getResponseToolSet(ctxRaw("plan the rollout step by step", "plan")))).toContain("respond_plan");
  });

  it("drops respond_<task> on an IMPLEMENTATION-intent prompt (no premature terminal answer)", () => {
    // Live (grok session 19fa8895c41c): an "Improve … implement these fixes"
    // prompt classified `debug` got respond_debug; the model called it mid-task
    // as a plan and the turn ended before the edits completed. Implementation
    // turns must fall through to markdown OUTPUT RULES, not a terminal tool.
    // Implementation intent takes precedence over a report signal.
    const impl = (raw: string, t: TaskType) => ({ ...makeCtx(t, null), raw });
    expect(
      getResponseToolSet(impl("Improve the story-list screen. Implement these prioritized fixes: …", "debug")),
    ).toEqual({});
    expect(getResponseToolSet(impl("Edit ONLY these two files and fix the empty span", "debug"))).toEqual({});
    expect(getResponseToolSet(impl("refactor the genre dropdown and wire up keyboard handlers", "analyze"))).toEqual(
      {},
    );
    expect(getResponseToolSet(impl("triển khai các cải tiến đã đề xuất", "plan"))).toEqual({});
  });
});

describe("getResponseToolSet — Phase 2b deliverableKind consume (model overrides regex)", () => {
  const ctxD = (raw: string, t: TaskType, deliverableKind: "answer" | "code" | "report") => ({
    ...makeCtx(t, null),
    raw,
    deliverableKind,
  });

  it("deliverableKind='code' DROPS respond_* even when the prompt reads as a report/list", () => {
    // Legacy regex (prefersStructuredReport) would KEEP the tool on "list all …".
    // The model said the deliverable is code → drop it (edits, not a report).
    expect(getResponseToolSet(ctxD("list all cost leaks in the orchestrator", "analyze", "code"))).toEqual({});
  });

  it("deliverableKind='report' KEEPS respond_* even when the prompt is question-shaped", () => {
    // Legacy regex (isQuestionLike) would DROP the tool on "why does …?". The
    // model said the deliverable is a structured report → keep it.
    const tools = getResponseToolSet(ctxD("why does the suite fail — break it down by cause", "analyze", "report"));
    expect(Object.keys(tools)).toContain("respond_analyze");
  });

  it("deliverableKind='answer' DROPS respond_* for non-general even on a report-shaped request", () => {
    expect(getResponseToolSet(ctxD("plan the migration step by step", "plan", "answer"))).toEqual({});
  });

  it("deliverableKind='answer' KEEPS respond_general (general is exempt — renders as plain markdown)", () => {
    const tools = getResponseToolSet(ctxD("what does the enrichment layer do?", "general", "answer"));
    expect(Object.keys(tools)).toContain("respond_general");
  });

  it("falls back to the legacy regex when deliverableKind is absent (null)", () => {
    // No model signal → legacy path: question-shaped analyze drops the tool.
    expect(getResponseToolSet({ ...makeCtx("analyze", null), raw: "why does the build fail?" })).toEqual({});
    // …and an explicit report request keeps it.
    expect(Object.keys(getResponseToolSet({ ...makeCtx("analyze", null), raw: "list all cost leaks" }))).toContain(
      "respond_analyze",
    );
  });

  it("DROPS respond_* on an implement turn even when mis-classified as report (session 2b7a10219499)", () => {
    // "lên plan rồi improvement … cải thiện X" is an implement turn the model
    // tagged deliverable=report; the report-exception used to KEEP respond_plan,
    // so the model stated a plan and ended the turn with edits done but
    // uncommitted/unreported. Implementation intent must suppress the terminal
    // tool BEFORE the deliverable branch is consulted.
    expect(
      getResponseToolSet(ctxD("lên plan rồi improvement nhé, focus cải thiện Compaction", "plan", "report")),
    ).toEqual({});
    expect(getResponseToolSet(ctxD("improve the compactor and implement the fix", "plan", "report"))).toEqual({});
  });
});

describe("applyPilSuffix — outputStyle variants", () => {
  const styles: OutputStyle[] = ["concise", "detailed", "balanced"];

  it("each style produces a different suffix for the same taskType (using non-action task)", () => {
    // Action tasks (debug/refactor/generate) coerce style=detailed → concise
    // unless the prompt literally asks for detail, so they only have 2 distinct
    // suffix shapes from the 3 inputs. Use a non-action task (plan) to verify
    // style variants are still routed through.
    const suffixes = styles.map((s) => applyPilSuffix("", makeCtx("plan", s)));
    const unique = new Set(suffixes);
    expect(unique.size).toBe(styles.length);
  });

  it.each(styles)("debug suffix always present for style=%s", (style) => {
    const result = applyPilSuffix("", makeCtx("debug", style));
    expect(result).toContain("OUTPUT RULES (debug)");
  });

  it("detailed suffix allows explanation on non-action task (plan)", () => {
    // Action-task coercion: refactor+detailed → concise (no "full rationale").
    // The behavior we care about — that "detailed" really carries through to a
    // longer suffix — is still observable on plan.
    const result = applyPilSuffix("", makeCtx("plan", "detailed"));
    expect(result).toContain("full rationale");
  });

  it("concise suffix restricts prose", () => {
    const result = applyPilSuffix("", makeCtx("refactor", "concise"));
    expect(result).toContain("No prose");
  });

  it("coerces refactor+detailed → concise when prompt has no detail-request keywords (session 127140a47b56)", () => {
    const ctx = makeCtx("refactor", "detailed");
    ctx.raw = "rename foo to bar across the repo";
    const result = applyPilSuffix("", ctx);
    expect(result).toContain("No prose");
    expect(result).not.toContain("full rationale");
  });

  it("honors refactor+detailed when the prompt explicitly asks for detail", () => {
    const ctx = makeCtx("refactor", "detailed");
    ctx.raw = "refactor this module and explain in detail what you changed";
    const result = applyPilSuffix("", ctx);
    expect(result).toContain("full rationale");
  });

  it("honors refactor+detailed when the Vietnamese prompt asks for chi tiết", () => {
    const ctx = makeCtx("refactor", "detailed");
    ctx.raw = "refactor module này và giải thích chi tiết cho tôi";
    const result = applyPilSuffix("", ctx);
    expect(result).toContain("full rationale");
  });
});

describe("layer6Output — style resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses ctx.outputStyle from L1 directly when already set — no brain call", async () => {
    const brain = await getMockBrain();
    const result = await layer6Output(makeCtx("debug", "concise"));
    expect(result.layers[0].delta).toContain("style=concise");
    expect(result.layers[0].delta).toContain("src=inherited");
    expect(brain).not.toHaveBeenCalled();
  });

  it("uses detailed style when passed from L1", async () => {
    const result = await layer6Output(makeCtx("plan", "detailed"));
    expect(result.layers[0].delta).toContain("style=detailed");
    expect(result.layers[0].delta).toContain("src=inherited");
  });

  it("when ctx.taskType is null, layer is not applied", async () => {
    const result = await layer6Output(makeCtx(null, null));
    expect(result.layers[0].applied).toBe(false);
  });

  it("PIL-03a: rescues outputStyle via brain when L1 returns null", async () => {
    const brain = await getMockBrain();
    brain.mockResolvedValueOnce("detailed");
    const result = await layer6Output(makeCtx("plan", null));
    expect(result.outputStyle).toBe("detailed");
    expect(result.layers[0].delta).toContain("style=detailed");
    expect(result.layers[0].delta).toContain("src=brain-rescue");
  });

  // PIL-L6 verbosity fix — debug default flipped to "concise" to stop the
  // model from padding root-cause analysis with rationale prose.
  it("PIL-03b: uses task-type heuristic when brain returns null (debug→concise)", async () => {
    const result = await layer6Output(makeCtx("debug", null));
    expect(result.outputStyle).toBe("concise");
    expect(result.layers[0].delta).toContain("style=concise");
    expect(result.layers[0].delta).toContain("src=task-heuristic");
  });

  it("PIL-03b: task-heuristic for plan→balanced (not detailed — avoids generating extra sections)", async () => {
    const result = await layer6Output(makeCtx("plan", null));
    expect(result.outputStyle).toBe("balanced");
    expect(result.layers[0].delta).toContain("style=balanced");
  });

  it("PIL-03b: task-heuristic for generate→concise", async () => {
    const result = await layer6Output(makeCtx("generate", null));
    expect(result.outputStyle).toBe("concise");
    expect(result.layers[0].delta).toContain("style=concise");
  });

  it("PIL-03b: task-heuristic for refactor→concise", async () => {
    const result = await layer6Output(makeCtx("refactor", null));
    expect(result.outputStyle).toBe("concise");
  });

  it("skips classifyViaBrain rescue when ctx._brainData is populated (style guaranteed by L1)", async () => {
    const brain = await getMockBrain();
    brain.mockClear();
    const ctx: PipelineContext = {
      ...makeCtx("plan", "balanced"),
      _brainData: { t0_principles: [], t1_rules: [], t2_patterns: [], retrieval_skipped_reason: null },
    };
    await layer6Output(ctx);
    expect(brain).not.toHaveBeenCalled();
  });

  it("PIL-03: resolved outputStyle propagated back onto ctx", async () => {
    // PIL-L6 verbosity fix — analyze default also flipped to "concise".
    const result = await layer6Output(makeCtx("analyze", null));
    expect(result.outputStyle).not.toBeNull();
    expect(result.outputStyle).toBe("concise");
  });
});

describe("layer6Output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with taskType=debug — applied=true, delta contains suffix=debug and style", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx("debug", "concise"));
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=debug/);
    expect(result.layers[0].delta).toMatch(/style=concise/);
    expect(result.layers[0].delta).toMatch(/chars=\d+/);
  });

  it("with taskType=refactor — applied=true, delta contains suffix=refactor", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const result = await layer6Output(makeCtx("refactor", "detailed"));
    expect(result.layers[0].applied).toBe(true);
    expect(result.layers[0].delta).toMatch(/suffix=refactor/);
    expect(result.layers[0].delta).toMatch(/style=detailed/);
  });

  it("with taskType=null — applied=false, delta=null", async () => {
    const result = await layer6Output(makeCtx(null));
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBeNull();
  });

  it("chitchat short-circuit: skips suffix work, marks delta=skip:chitchat", async () => {
    const brain = await getMockBrain();
    const ctx: PipelineContext = { ...makeCtx("general", "concise"), intentKind: "chitchat" };
    const result = await layer6Output(ctx);
    expect(result.layers[0].applied).toBe(false);
    expect(result.layers[0].delta).toBe("skip:chitchat");
    expect(brain).not.toHaveBeenCalled();
  });

  it("applyPilSuffix: returns prompt unchanged when intentKind=chitchat", () => {
    const ctx: PipelineContext = { ...makeCtx("general", "concise"), intentKind: "chitchat" };
    const system = "SYSTEM";
    expect(applyPilSuffix(system, ctx)).toBe(system);
  });

  it("enriched unchanged (Layer 6 modifies system prompt only)", async () => {
    const { classifyViaBrain } = await import("../../ee/bridge.js");
    vi.mocked(classifyViaBrain).mockResolvedValue(null);

    const ctx = makeCtx("generate");
    const result = await layer6Output(ctx);
    expect(result.enriched).toBe(ctx.enriched);
  });
});

describe("isQuestionLike — Vietnamese yes/no question frames (regression: session f6f7881a5fae)", () => {
  it("detects the live miss: 'check ... dùng được mcp ... không nhé'", () => {
    // The exact prompt that was mis-routed to the implement/verify scaffold.
    expect(isQuestionLike("bạn check xem dùng được mcp muonroi-docs không nhé")).toBe(true);
    // It is NOT an implementation intent, so layer4-gsd's informational gate fires.
    expect(isImplementationIntent("bạn check xem dùng được mcp muonroi-docs không nhé")).toBe(false);
  });

  it("detects common VI yes/no tails", () => {
    expect(isQuestionLike("dùng được không")).toBe(true);
    expect(isQuestionLike("cái này chạy được không vậy")).toBe(true);
    expect(isQuestionLike("đúng không")).toBe(true);
    expect(isQuestionLike("phải không nhỉ")).toBe(true);
    expect(isQuestionLike("test đã pass chưa")).toBe(true);
    expect(isQuestionLike("xong chưa ạ")).toBe(true);
    expect(isQuestionLike("có chạy được không?")).toBe(true);
  });

  it("does NOT treat a mid-sentence negation as a question", () => {
    // "không là hỏng" = "or it breaks" — 'không' is not the clause-final particle.
    expect(isQuestionLike("đừng commit file .env không là lộ key")).toBe(false);
    // Plain imperative with a 'nhé' softener (no 'không'/'chưa' tail) stays a task.
    expect(isQuestionLike("sửa giúp tôi cái này nhé")).toBe(false);
    expect(isQuestionLike("triển khai tính năng login")).toBe(false);
  });

  it("still detects the pre-existing EN/VI question shapes", () => {
    expect(isQuestionLike("why does the build fail?")).toBe(true);
    expect(isQuestionLike("tại sao build lỗi")).toBe(true);
    expect(isQuestionLike("explain the pipeline")).toBe(true);
  });
});

describe("isImplementationIntent — improve / cải thiện (regression: session 2b7a10219499)", () => {
  it("recognises improve/improvement + VI cải thiện as implement turns", () => {
    expect(isImplementationIntent("improve the compactor")).toBe(true);
    expect(isImplementationIntent("lên plan rồi improvement nhé")).toBe(true);
    expect(isImplementationIntent("focus cải thiện Compaction")).toBe(true);
    expect(isImplementationIntent("cai thien phan compaction")).toBe(true);
  });

  it("does not over-match analysis questions that merely describe behaviour", () => {
    expect(isImplementationIntent("what does the enrichment layer do?")).toBe(false);
    expect(isImplementationIntent("why does the suite fail — break it down")).toBe(false);
  });
});
