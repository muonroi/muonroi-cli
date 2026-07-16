import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import {
  classifierBudget,
  classifySubSessionAction,
  createLlmClassifier,
  orderClassifyCandidates,
} from "../llm-classify.js";

describe("createLlmClassifier (PIL Layer 1 Pass 4)", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("parses a clean two-word reply into TaskType + style", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("ci action github fail, fix giúp tôi");

    expect(result).not.toBeNull();
    expect(result?.taskType).toBe("debug");
    expect(result?.outputStyle).toBe("concise");
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it("parses the three-word reply and marks chitchat from the intent word", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("general,concise,chat") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("cảm ơn bạn nhé");
    expect(result?.taskType).toBe("general");
    expect(result?.intentKind).toBe("chitchat");
  });

  it("treats a general QUESTION as task, not chitchat (keep-tools)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("general,concise,task") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("bạn thử call tool setup_guide xem được không");
    expect(result?.intentKind).toBe("task");
  });

  it("defaults intentKind to task when the model omits the third word (backward compatible)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("fix the failing build");
    expect(result?.taskType).toBe("debug");
    expect(result?.intentKind).toBe("task");
  });

  it("injects the recent-conversation digest so a terse follow-up is classified in context", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("plan,concise,task,report,heavy") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");

    const digest = "[user]: phân tích PIL pipeline nặng | [assistant]: đã phân tích 5 tầng chi tiết";
    const result = await classify("ok từ các phần đó debate mode lên plan", { recentTurns: digest });
    expect(result?.taskType).toBe("plan");

    // The prompt actually sent to the model must carry the digest + the framing
    // that tells it to classify the NEW message (not the conversation block).
    // "NEW USER MESSAGE" is unique to the injected block (the system prompt never
    // uses that phrase), so it distinguishes injected-context from no-context.
    const sent = JSON.stringify(handle.calls);
    expect(sent).toContain("NEW USER MESSAGE");
    expect(sent).toContain("phân tích PIL pipeline nặng");
  });

  it("omits the conversation block entirely when no recentTurns is provided", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    await classify("fix the failing build");
    const sent = JSON.stringify(handle.calls);
    // The injected-block marker must be absent; the system prompt's mention of a
    // '[RECENT CONVERSATION]' block does not use this phrase.
    expect(sent).not.toContain("NEW USER MESSAGE");
  });

  it("returns null when the reply cannot be parsed", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("¯\\_(ツ)_/¯") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("hello");

    expect(result).toBeNull();
  });

  it("self-repairs: an unparseable first reply triggers a second model call that recovers", async () => {
    // Sequenced mock: doStream #1 returns garbage → parseResponse null → the
    // classifier's self-repair fires a SECOND call (full context + format-repair
    // instruction) → doStream #2 returns a clean 8-word line → recovered. This is
    // the agent-first recovery that replaced the regex fallback.
    const handle = installMockModel({
      fixture: {
        stream: [
          textOnlyStream("¯\\_(ツ)_/¯ sorry, here is my analysis in prose"),
          textOnlyStream("refactor,concise,task,code,heavy,local,english,clear"),
        ],
      },
    });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("vendor the gsd subset natively and rename across the repo");
    expect(result?.taskType).toBe("refactor");
    expect(result?.depthTier).toBe("heavy");
    expect(result?.needsClarification).toBe(false);
  });

  it("accepts a taskType-only reply (style optional)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("plan") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("design a sharded queue");

    expect(result?.taskType).toBe("plan");
    expect(result?.outputStyle).toBeNull();
  });

  it("ignores noisy formatting (markdown, quotes, newlines)", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream('**"refactor, balanced"**\n\nrationale: ...') },
    });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("tái cấu trúc auth module");

    expect(result?.taskType).toBe("refactor");
    expect(result?.outputStyle).toBe("balanced");
  });

  // Reasoning models (grok-4.5, deepseek-v4-flash) consumed the doomed 16-token
  // budget on reasoning tokens FIRST → emitted zero text-delta → parseResponse
  // saw "" → returned null. 5/5 live grok sessions showed `llm=fail`. Fix: give
  // reasoning models a real output budget + force the lowest reasoning effort the
  // provider supports, so the 2-word answer actually streams back.
  it("gives a reasoning model a real output budget (not the doomed 16)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("grok-4.5"); // reasoning:true
    const result = await classify("fix the failing CI build");

    expect(result?.taskType).toBe("debug");
    const call = handle.calls[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBeGreaterThanOrEqual(1024);
  });

  it("forces low reasoning effort for reasoning models that support it", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("grok-4.5"); // xai, supports_effort:true
    await classify("fix the failing CI build");

    const call = handle.calls[0] as {
      providerOptions?: Record<string, Record<string, unknown>>;
    };
    expect(call.providerOptions?.xai?.reasoningEffort).toBe("low");
  });

  it("recovers the verdict from the reasoning channel when text is empty", async () => {
    // Some reasoning models route the whole 2-word answer into reasoning parts
    // and commit no text. The classifier must still recover it.
    const reasoningOnly = [
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "debug,concise" },
      { type: "reasoning-end", id: "r1" },
      {
        type: "finish",
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 0, reasoning: 5 },
        },
      },
    ] as never;
    const handle = installMockModel({ fixture: { stream: reasoningOnly } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("grok-4.5");
    const result = await classify("fix the failing CI build");

    expect(result?.taskType).toBe("debug");
    expect(result?.outputStyle).toBe("concise");
  });

  it("keeps a tiny output budget for non-reasoning models (56 — eight comma words)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("generate,concise") } });
    cleanup = handle.uninstall;

    const classify = createLlmClassifier("deepseek-chat-lite"); // non-catalog, reasoning:false
    await classify("add a new endpoint");

    const call = handle.calls[0] as { maxOutputTokens?: number };
    expect(call.maxOutputTokens).toBe(56);
  });

  it("parses the sixth + seventh words as agent-first scope and reply-language", async () => {
    const eco = installMockModel({
      fixture: { stream: textOnlyStream("analyze,balanced,task,answer,standard,ecosystem,vietnamese") },
    });
    cleanup = eco.uninstall;
    const ecoClassify = createLlmClassifier("deepseek-v4-flash");
    const r = await ecoClassify("hệ sinh thái muonroi gồm những gì");
    expect(r?.ecosystemScope).toBe(true);
    expect(r?.replyLanguage).toBe("Vietnamese");
    eco.uninstall();

    // English + local → no nudge signals (ecosystemScope false, replyLanguage null).
    const plain = installMockModel({
      fixture: { stream: textOnlyStream("debug,concise,task,code,standard,local,english") },
    });
    cleanup = plain.uninstall;
    const plainClassify = createLlmClassifier("deepseek-v4-flash");
    const p = await plainClassify("fix the crash");
    expect(p?.ecosystemScope).toBe(false);
    expect(p?.replyLanguage).toBeNull();
  });

  it("parses the fourth word as the output deliverable (Phase 2b)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise,task,code,standard") } });
    cleanup = handle.uninstall;
    const classify = createLlmClassifier("deepseek-v4-flash");
    const result = await classify("fix the crash in src/auth/login.ts");
    expect(result?.taskType).toBe("debug");
    expect(result?.deliverableKind).toBe("code");
  });

  it("parses the fifth word as the model-decided work depth (agent-first tier)", async () => {
    const heavy = installMockModel({ fixture: { stream: textOnlyStream("refactor,concise,task,code,heavy") } });
    cleanup = heavy.uninstall;
    const heavyClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await heavyClassify("rework the auth system"))?.depthTier).toBe("heavy");
    heavy.uninstall();

    // Position-independent recovery (taskType still leads; depth appears early).
    const reordered = installMockModel({ fixture: { stream: textOnlyStream("debug,quick,concise,task,code") } });
    cleanup = reordered.uninstall;
    const reorderedClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await reorderedClassify("fix typo"))?.depthTier).toBe("quick");
    reordered.uninstall();

    const noDepth = installMockModel({ fixture: { stream: textOnlyStream("debug,concise,task,code") } });
    cleanup = noDepth.uninstall;
    const noDepthClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await noDepthClassify("fix the bug"))?.depthTier).toBeNull();
  });

  it("parses the clarity signal (needsClarification) position-independently, null when absent", async () => {
    // 'underspecified' → needsClarification true (earns the interview/Council path).
    const vague = installMockModel({
      fixture: { stream: textOnlyStream("generate,concise,task,code,standard,local,english,underspecified") },
    });
    cleanup = vague.uninstall;
    const vagueClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await vagueClassify("add auth"))?.needsClarification).toBe(true);
    vague.uninstall();

    // 'clear' → false. A fully-specified migration is clear even though heavy.
    const clear = installMockModel({
      fixture: { stream: textOnlyStream("refactor,concise,task,code,heavy,local,english,clear") },
    });
    cleanup = clear.uninstall;
    const clearClassify = createLlmClassifier("deepseek-v4-flash");
    const cr = await clearClassify("vendor the gsd subset natively and rename to workflow, keep tests green");
    expect(cr?.needsClarification).toBe(false);
    expect(cr?.depthTier).toBe("heavy");
    clear.uninstall();

    // Absent 8th word → null (don't-over-ask safe direction). "clear"/"underspecified"
    // must NOT be mistaken for the open-vocabulary language word.
    const noClarity = installMockModel({ fixture: { stream: textOnlyStream("debug,concise,task,code,standard") } });
    cleanup = noClarity.uninstall;
    const noClarityClassify = createLlmClassifier("deepseek-v4-flash");
    const nr = await noClarityClassify("fix the bug");
    expect(nr?.needsClarification).toBeNull();
    expect(nr?.replyLanguage).toBeNull();
  });

  it("recovers the deliverable position-independently and defaults to null when absent", async () => {
    const reportHandle = installMockModel({ fixture: { stream: textOnlyStream("analyze,concise,task,report") } });
    cleanup = reportHandle.uninstall;
    const reportClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await reportClassify("list every env var the CLI reads"))?.deliverableKind).toBe("report");
    reportHandle.uninstall();

    // Model omits the 4th word → deliverableKind null (consumers fall back to regex).
    const bareHandle = installMockModel({ fixture: { stream: textOnlyStream("debug,concise") } });
    cleanup = bareHandle.uninstall;
    const bareClassify = createLlmClassifier("deepseek-v4-flash");
    expect((await bareClassify("fix it"))?.deliverableKind).toBeNull();
  });
});

describe("classifierBudget (flat timeout ceiling; max-output scales with reasoning)", () => {
  // Harness-measured 2026-07-15 (grok-composer via OAuth, 7 samples): classify
  // latency is 1045–1277ms — provider-independent and well under any ceiling. The
  // /ideal over-engineering root cause was NOT a timeout abort but grok-composer
  // ignoring the terse 8-word contract (it emits task-planning prose → null →
  // fail-open "standard"). So the timeout is a flat safety net for ALL models;
  // only max-output stays coupled to the reasoning flag (a reasoning model burns
  // its output budget on reasoning tokens before any visible text).
  it("gives every model the same flat timeout — balanced non-reasoning (grok-composer)", () => {
    const b = classifierBudget({ reasoning: false, tier: "balanced" });
    expect(b.timeoutMs).toBe(8000);
    // max-output stays tiny — a non-reasoning model emits the 8 words directly.
    expect(b.maxOutputTokens).toBe(56);
  });

  it("same flat timeout for a fast-tier model", () => {
    const b = classifierBudget({ reasoning: false, tier: "fast" });
    expect(b.timeoutMs).toBe(8000);
    expect(b.maxOutputTokens).toBe(56);
  });

  it("reasoning model earns the larger max-output budget (still flat timeout)", () => {
    const b = classifierBudget({ reasoning: true, tier: "fast" });
    expect(b.timeoutMs).toBe(8000);
    expect(b.maxOutputTokens).toBe(2048);
  });

  it("premium non-reasoning also gets the flat timeout and small budget", () => {
    const b = classifierBudget({ reasoning: false, tier: "premium" });
    expect(b.timeoutMs).toBe(8000);
    expect(b.maxOutputTokens).toBe(56);
  });

  it("treats an unknown (non-catalog) model as non-reasoning with the flat timeout", () => {
    const b = classifierBudget(undefined);
    expect(b.timeoutMs).toBe(8000);
    expect(b.maxOutputTokens).toBe(56);
  });
});

describe("classifySubSessionAction", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("correctly parses SPAWN_SUB_SESSION from model response", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("SPAWN_SUB_SESSION,0.98,Requires writing a test suite") },
    });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "fix all compile errors");
    expect(result).not.toBeNull();
    expect(result?.action).toBe("SPAWN_SUB_SESSION");
    expect(result?.confidence).toBe(0.98);
    expect(result?.reason).toBe("Requires writing a test suite");
  });

  it("correctly parses DIRECT_ANSWER from model response", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("DIRECT_ANSWER,0.95,Simple query") } });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "explain database index");
    expect(result?.action).toBe("DIRECT_ANSWER");
    expect(result?.confidence).toBe(0.95);
  });

  it("routes obvious inputs (greeting/math) through the MODEL — no regex heuristic short-circuit", async () => {
    // The keyword/list heuristic was removed (2026-07-07, no-regex rule): every
    // prompt, including "hello", now goes to the model router. A throwing factory
    // would surface if any short-circuit remained.
    const handle = installMockModel({ fixture: { stream: textOnlyStream("DIRECT_ANSWER,0.9,greeting") } });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "hello");
    expect(result?.action).toBe("DIRECT_ANSWER");
    expect(result?.confidence).toBe(0.9);
  });

  it("does not route greetings/thanks via heuristic if they contain other text (fuzzy bypass prevention)", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("SPAWN_SUB_SESSION,0.95,Delete file task") } });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "hello, delete file X");
    expect(result?.action).toBe("SPAWN_SUB_SESSION");
  });

  it("correctly parses ROTATE_SESSION from model response", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("ROTATE_SESSION,0.90,New topic") } });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "switch topic");
    expect(result?.action).toBe("ROTATE_SESSION");
  });

  it("returns null when the reply cannot be parsed", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("bad response") } });
    cleanup = handle.uninstall;
    const result = await classifySubSessionAction("deepseek-v4-flash", "test");
    expect(result).toBeNull();
  });
});

describe("orderClassifyCandidates — cross-provider fallback ordering", () => {
  const cross = [
    { modelId: "deepseek-v4-flash", providerId: "deepseek" as const },
    { modelId: "opencode/deepseek-v4-flash", providerId: "opencode-go" as const },
  ];

  it("same-provider fast tier goes FIRST, cross-provider appended as fallback", () => {
    // Regression: an openai-OAuth session routes to gpt-5.4-mini (a real fast
    // tier); if that primary ERRORS (401 on the api-key path), the chain must
    // still fall through to keyed cross-provider models — previously it did not,
    // because cross-provider was only added when NO same-provider fast tier
    // existed, so the classify fail-opened to "standard" and /ideal over-councilled.
    const out = orderClassifyCandidates({ primaryModelId: "gpt-5.4-mini", hasSameFast: true, crossModels: cross });
    expect(out).toEqual([
      { modelId: "gpt-5.4-mini", providerId: null },
      { modelId: "deepseek-v4-flash", providerId: "deepseek" },
      { modelId: "opencode/deepseek-v4-flash", providerId: "opencode-go" },
    ]);
  });

  it("no same-provider fast tier: cross-provider FIRST, session model LAST", () => {
    // xai has no fast tier and its session model is agentic (ignores the terse
    // contract) — so keyed cross-provider fast models are tried before it.
    const out = orderClassifyCandidates({ primaryModelId: "grok-composer", hasSameFast: false, crossModels: cross });
    expect(out).toEqual([
      { modelId: "deepseek-v4-flash", providerId: "deepseek" },
      { modelId: "opencode/deepseek-v4-flash", providerId: "opencode-go" },
      { modelId: "grok-composer", providerId: null },
    ]);
  });

  it("no cross models: just the primary candidate (both hasSameFast values)", () => {
    expect(orderClassifyCandidates({ primaryModelId: "m", hasSameFast: true, crossModels: [] })).toEqual([
      { modelId: "m", providerId: null },
    ]);
    expect(orderClassifyCandidates({ primaryModelId: "m", hasSameFast: false, crossModels: [] })).toEqual([
      { modelId: "m", providerId: null },
    ]);
  });
});
