import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCouncil } from "../../src/council/index.js";
import type { CouncilLLM } from "../../src/council/types.js";
import type { StreamChunk } from "../../src/types/index.js";

// ── Mock LLM that simulates realistic model responses ────────────────────────

function createMockLLM(responses: Record<string, string>): CouncilLLM {
  let callCount = 0;
  return {
    async generate(_modelId: string, system: string, prompt: string, _maxTokens?: number): Promise<string> {
      callCount++;
      // Match response based on prompt/system content
      for (const [key, value] of Object.entries(responses)) {
        if (system.includes(key) || prompt.includes(key)) return value;
      }
      // Fallback: return generic response based on phase detection
      if (system.includes("preparing for a multi-expert discussion") || system.includes("clarification")) {
        return responses._clarify ?? "[]";
      }
      if (system.includes("synthesizing a discussion brief")) {
        return (
          responses._spec ??
          '{"problemStatement":"test","constraints":[],"successCriteria":["resolve topic"],"scope":"test"}'
        );
      }
      if (system.includes("entering a discussion")) {
        return responses._opening ?? "I think we should consider approach A because of X, Y, Z. What do you think?";
      }
      if (system.includes("responding to")) {
        return responses._response ?? "I agree on X but disagree on Y. Here's my reasoning...";
      }
      if (system.includes("continuing a discussion")) {
        return responses._followup ?? "Good point. I've updated my thinking on Y. Are we aligned now?";
      }
      if (system.includes("evaluating whether")) {
        return (
          responses._evaluation ??
          '{"allCriteriaMet":true,"criteriaStatus":[{"criterion":"test","met":true,"evidence":"agreed"}],"unresolvedPoints":[],"needsResearch":false,"shouldContinue":false,"reason":"All criteria addressed"}'
        );
      }
      if (system.includes("research phase is needed")) {
        return (
          responses._researchNeed ?? '{"needsResearch":false,"reason":"General discussion, no codebase data needed"}'
        );
      }
      if (system.includes("team lead")) {
        return (
          responses._synthesis ??
          '{"type":"decision","summary":"Team agreed on approach A","agreed":["point 1"],"tradeoffs":["trade 1"],"recommendation":"Go with A","plan":{"steps":[{"description":"Implement A","priority":"high"}],"estimatedComplexity":"moderate","prerequisites":[]}}\n---READABLE---\n## AGREED\n- Point 1\n## RECOMMENDATION\nGo with A'
        );
      }
      if (system.includes("Summarize this discussion")) {
        return "- Agreed on X\n- Disputed: Y\n- New evidence: Z";
      }
      return `[Mock response #${callCount}]`;
    },
    async research(_modelId: string, _topic: string, _ctx: string): Promise<string> {
      return (
        responses._research ??
        "## Research Findings\n- Found relevant code in src/foo.ts\n## Key Evidence\n- Function bar() handles this\n## Gaps\n- None"
      );
    },
    async debate(modelId: string, system: string, prompt: string) {
      // Route debate calls through `generate` so the same keyword-based
      // response table drives them (e.g. "continuing a discussion").
      const text = await (async () => {
        // Match same keyword logic as `generate`
        for (const [key, value] of Object.entries(responses)) {
          if (system.includes(key) || prompt.includes(key)) return value;
        }
        if (system.includes("entering a discussion")) {
          return responses._opening ?? "I think we should consider approach A because of X, Y, Z. What do you think?";
        }
        if (system.includes("responding to")) {
          return responses._response ?? "I agree on X but disagree on Y. Here's my reasoning...";
        }
        if (system.includes("continuing a discussion")) {
          return responses._followup ?? "Good point. I've updated my thinking on Y. Are we aligned now?";
        }
        return `[Mock debate response]`;
      })();
      callCount++;
      return { text, toolCalls: [] };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectChunks(
  gen: AsyncGenerator<StreamChunk, string | null, unknown>,
): Promise<{ chunks: StreamChunk[]; result: string | null }> {
  const chunks: StreamChunk[] = [];
  let res: IteratorResult<StreamChunk, string | null>;
  do {
    res = await gen.next();
    if (!res.done && res.value) chunks.push(res.value);
  } while (!res.done);
  return { chunks, result: res.value };
}

function getContent(chunks: StreamChunk[]): string {
  // Council phases were promoted from inline `## Phase A/B/...` content lines
  // to typed `council_phase` stream events. Tests still want to assert "the
  // clarification phase ran" / "preflight was rejected" without coupling to
  // the transport, so we flatten labels + details into the same haystack and
  // map kinds back to their legacy phase aliases.
  const KIND_TO_LEGACY_PHASE: Record<string, string> = {
    clarification: "Phase A",
    preflight: "Phase B",
  };
  return chunks
    .map((c) => {
      if (c.type === "content") return c.content ?? "";
      if (c.type === "council_phase" && c.councilPhase) {
        const p = c.councilPhase;
        const legacy = KIND_TO_LEGACY_PHASE[p.kind] ?? "";
        return `\n${[legacy, p.label, p.detail].filter(Boolean).join(" ")}\n`;
      }
      // Bubble-UI migration: debate/leader/research/synthesis turns moved
      // from inline `content` chunks to typed `council_message` events.
      // Flatten the visible body (and a kind tag) so legacy assertions on
      // the rendered haystack still work without coupling to the transport.
      if (c.type === "council_message" && c.councilMessage) {
        const cm = c.councilMessage;
        const KIND_TAG: Record<string, string> = {
          debate: `Discussion Round ${cm.round ?? ""}`,
          leader: "Leader evaluation",
          research: "Research findings",
          synthesis: "Synthesis",
        };
        const tag = KIND_TAG[cm.kind] ?? cm.kind;
        return `\n${tag}\n${cm.text}\n`;
      }
      // Info-card migration: Clarified Spec / Discussion Brief / Debate Plan
      // moved from inline markdown to typed `council_info_card` events. Flatten
      // title + section headings + bodies so existing string assertions still
      // hit the haystack.
      if (c.type === "council_info_card" && c.councilInfoCard) {
        const card = c.councilInfoCard;
        const body = card.sections.map((s) => `${s.heading}\n${s.body}`).join("\n");
        return `\n${card.title}\n${body}\n`;
      }
      return "";
    })
    .join("");
}

function getQuestions(chunks: StreamChunk[]): StreamChunk[] {
  // Only count clarification-phase questions — post-debate prompts are a
  // separate UX surface and should not be conflated with clarification.
  return chunks.filter((c) => c.type === "council_question" && c.councilQuestion?.phase === "clarify");
}

function getPreflights(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.filter((c) => c.type === "council_preflight");
}

function getPhases(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.filter((c) => c.type === "council_phase");
}

function hasPhaseKind(chunks: StreamChunk[], kind: string): boolean {
  return getPhases(chunks).some((c) => c.councilPhase?.kind === kind);
}

// ── Mock infrastructure ──────────────────────────────────────────────────────

vi.mock("../../src/utils/settings.js", () => ({
  getRoleModel: (role: string) => (role === "leader" ? "mock-premium" : undefined),
  getRoleModels: () => ({ leader: "mock-premium" }),
  isCouncilMultiProviderPreferred: () => false,
  loadUserSettings: () => ({}),
  getCouncilExperienceMode: () => "advisory",
  isCouncilCostAware: () => false,
}));

vi.mock("../../src/pil/pipeline.js", () => ({
  runPipeline: async () => null,
}));

vi.mock("../../src/ee/council-bridge.js", () => ({
  queryExperience: async () => ({ warnings: [] }),
}));

vi.mock("../../src/council/leader.js", async (importOriginal) => {
  return {
    resolveLeaderModel: () => "mock-premium",
    resolveLeaderModelDetailed: async () => ({ modelId: "mock-premium" }),
    resolveParticipants: async () => [
      { role: "implement", model: "mock-balanced" },
      { role: "verify", model: "mock-premium" },
      { role: "research", model: "mock-fast" },
    ],
    hasMultiProviderConfig: () => false,
    pickCouncilTaskModel: (_task: string, leaderModelId: string) => leaderModelId,
  };
});

vi.mock("../../src/orchestrator/agent-options.js", () => ({
  COUNCIL_ROLE_COLORS: { implement: "", verify: "", research: "", leader: "" },
  COUNCIL_COLOR_RESET: "",
  COUNCIL_COLOR_BG: { implement: "", verify: "", research: "", leader: "" },
}));

vi.mock("../../src/storage/index.js", () => ({
  appendSystemMessage: vi.fn(),
  logInteraction: vi.fn(),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("Council E2E", () => {
  // ── Case 1: Easy — Vague topic "hãy thảo luận nhé" ────────────────────────
  // Real-world: user types something vague, system MUST ask clarifying questions
  describe("Case 1: Vague topic — 'hãy cùng thảo luận rồi giải quyết vấn đề nhé'", () => {
    it("should ask clarification questions instead of hallucinating", async () => {
      const llm = createMockLLM({
        _clarify: JSON.stringify([
          {
            question: "Bạn muốn thảo luận về vấn đề gì cụ thể?",
            why: "Topic quá mơ hồ",
            suggestions: ["Bug fix", "Architecture", "Feature mới"],
            isRequired: true,
          },
          { question: "Scope là gì? Ảnh hưởng file/module nào?", why: "Cần xác định phạm vi", isRequired: true },
        ]),
        _spec: JSON.stringify({
          problemStatement: "Cần fix EE status bar hiển thị sai trạng thái",
          constraints: ["Không thay đổi EE core API", "Backward compatible"],
          successCriteria: ["Status bar phản ánh đúng EE health", "Không regression trên existing tests"],
          scope: "src/ui/status-bar/ và src/ee/client.ts",
        }),
      });

      const questionAnswers = new Map<string, string>();
      let questionCount = 0;

      const respondToQuestion = (qid: string) => {
        questionCount++;
        return Promise.resolve(
          questionCount === 1
            ? "EE status bar đang hiển thị sai — healthy nhưng báo đỏ"
            : "Scope: src/ui/status-bar/ và src/ee/client.ts",
        );
      };

      const respondToPreflight = (_pid: string) => Promise.resolve(true);
      const processMessage = async function* (_msg: string): AsyncGenerator<StreamChunk, void, unknown> {
        yield { type: "content", content: "Executing..." };
      };

      const gen = runCouncil(
        "hãy cùng thảo luận rồi giải quyết vấn đề nhé",
        "deepseek-chat",
        [{ role: "user", content: "hãy cùng thảo luận rồi giải quyết vấn đề nhé" }],
        "test-session-1",
        llm,
        respondToQuestion,
        respondToPreflight,
        processMessage,
      );

      const { chunks } = await collectChunks(gen);
      const questions = getQuestions(chunks);
      const content = getContent(chunks);

      // Must ask questions — this is the core fix for the hallucination bug
      expect(questions.length).toBeGreaterThan(0);
      expect(questions[0].councilQuestion?.question).toContain("thảo luận");

      // Must show clarification phase
      expect(content).toContain("Phase A");

      // Must show pre-flight
      const preflights = getPreflights(chunks);
      expect(preflights.length).toBeGreaterThan(0);

      // Must NOT hallucinate about canary releases or generic ML topics
      expect(content).not.toContain("canary release");
      expect(content).not.toContain("accuracy cao hơn 15-20%");
    });
  });

  // ── Case 2: Medium — Specific technical question ───────────────────────────
  // Real-world: user asks about a real architecture decision with enough context
  describe("Case 2: Architecture decision — REST vs gRPC for internal services", () => {
    it("should clarify constraints then run focused debate", async () => {
      const llm = createMockLLM({
        _clarify: JSON.stringify([
          {
            question: "Team size? Có kinh nghiệm gRPC không?",
            why: "gRPC learning curve cao",
            suggestions: ["< 5 người", "5-15", "> 15"],
            isRequired: true,
          },
          { question: "Latency requirement? P99 target?", why: "gRPC nhanh hơn nhưng phức tạp hơn", isRequired: true },
        ]),
        _spec: JSON.stringify({
          problemStatement: "Chọn protocol cho internal microservice communication: REST vs gRPC",
          constraints: [
            "Team 8 người, 2 có kinh nghiệm gRPC",
            "P99 < 100ms",
            "Cần backward compat với existing REST clients 6 tháng",
          ],
          successCriteria: [
            "Chọn được protocol phù hợp với team size và skill",
            "Đánh giá performance vs complexity trade-off",
            "Plan migration nếu cần",
          ],
          scope: "Internal service-to-service communication only, không ảnh hưởng public API",
        }),
        _researchNeed: '{"needsResearch":false,"reason":"Architecture discussion, no codebase data needed"}',
        _opening:
          "From an implementation perspective, I recommend starting with gRPC for new services while keeping REST for existing ones. The binary protocol gives us 2-5x throughput improvement, and protobuf schemas enforce contracts. However, the team needs training...",
        _response:
          "I partially agree. The performance benefits are real, but with only 2/8 members knowing gRPC, the ramp-up cost is significant. I'd suggest a phased approach: REST-first for the next quarter, then pilot gRPC on one low-risk service...",
        _evaluation: JSON.stringify({
          allCriteriaMet: true,
          criteriaStatus: [
            { criterion: "Chọn protocol phù hợp", met: true, evidence: "Both agree on phased approach" },
            { criterion: "Performance vs complexity", met: true, evidence: "Quantified: 2-5x gain vs 2-month ramp-up" },
            {
              criterion: "Migration plan",
              met: true,
              evidence: "Phase 1: REST, Phase 2: gRPC pilot, Phase 3: full migration",
            },
          ],
          unresolvedPoints: [],
          needsResearch: false,
          shouldContinue: false,
          reason: "All 3 success criteria addressed with concrete plan",
        }),
      });

      let questionIndex = 0;
      const answers = ["Team 8 người, 2 biết gRPC", "P99 < 100ms, throughput 10k req/s"];

      const gen = runCouncil(
        "REST vs gRPC cho internal microservices",
        "deepseek-chat",
        [{ role: "user", content: "REST vs gRPC cho internal microservices" }],
        "test-session-2",
        llm,
        (_qid) => Promise.resolve(answers[questionIndex++] ?? "N/A"),
        (_pid) => Promise.resolve(true),
        async function* () {
          yield { type: "content" as const, content: "ok" };
        },
      );

      const { chunks } = await collectChunks(gen);
      const content = getContent(chunks);

      // Should have clarification
      expect(getQuestions(chunks).length).toBeGreaterThan(0);

      // Should have debate content
      expect(content).toContain("Opening Analysis");
      expect(content).toContain("Discussion Round");

      // Leader should evaluate and stop when criteria met
      expect(content).toContain("Leader evaluation");
      expect(content).toContain("criteria met");

      // Should have synthesis
      expect(content).toContain("Synthesis");
    });
  });

  // ── Case 3: Complex — Multi-faceted problem with research needed ───────────
  // Real-world: user has a complex bug involving multiple systems
  describe("Case 3: Complex debugging — EE core not working, needs codebase research", () => {
    it("should detect research need and run mid-context investigation", async () => {
      const llm = createMockLLM({
        _clarify: JSON.stringify([
          { question: "Lỗi cụ thể là gì? Error message?", why: "Cần biết chính xác lỗi", isRequired: true },
          {
            question: "Từ khi nào bắt đầu lỗi? Có thay đổi gì gần đây không?",
            why: "Xác định regression",
            isRequired: false,
          },
        ]),
        _spec: JSON.stringify({
          problemStatement:
            "EE (Experience Engine) core không hoạt động — send() fails với 'undefined', ECONNREFUSED trên port 9876",
          constraints: ["Không thay đổi EE protocol", "Must maintain backward compat với existing brain data"],
          successCriteria: [
            "EE send() hoạt động không lỗi",
            "Status bar phản ánh đúng EE state",
            "Existing EE data không bị mất",
            "All existing tests pass",
          ],
          scope: "src/ee/ directory, src/ui/status-bar/store.ts",
        }),
        _researchNeed:
          '{"needsResearch":true,"reason":"Need to check actual error in src/ee/client.ts and status-bar/store.ts"}',
        _research:
          "## Research Findings\n- src/ee/client.ts:42 — send() called before transport ready\n- src/ee/intercept.ts:15 — leftover TCP config on port 9876\n- Status bar checks getCircuitState() which returns 'open' (error state)\n\n## Key Evidence\n- `transport.send is not a function` at client.ts:42\n- Config still references port 9876 but IPC is on stdio now\n\n## Gaps\n- Need to verify if version mismatch between CLI and EE core",
        _opening:
          "Based on the research, I see 3 issues: (1) race condition in send() — transport not initialized, (2) leftover TCP config causing ECONNREFUSED, (3) status bar reads circuit breaker state which is 'open' due to errors. I propose fixing in order: config cleanup → readiness handshake → status bar fix.",
        _response:
          "Agree on the diagnosis but I'd prioritize differently. The version mismatch should be checked FIRST — if versions are incompatible, the other fixes won't help. My order: version check → config cleanup → send() race condition → status bar.",
        _evaluation: JSON.stringify({
          allCriteriaMet: false,
          criteriaStatus: [
            { criterion: "EE send() works", met: true, evidence: "Both agree on readiness handshake fix" },
            { criterion: "Status bar correct", met: true, evidence: "Fix circuit breaker state after send() works" },
            { criterion: "Existing data preserved", met: true, evidence: "Config changes don't affect brain data" },
            { criterion: "All tests pass", met: false, evidence: "Need to verify after implementation" },
          ],
          unresolvedPoints: ["Fix order: version-first vs config-first"],
          needsResearch: false,
          shouldContinue: true,
          reason: "One criterion unverifiable pre-implementation, fix order disputed",
        }),
      });

      // After first round, second evaluation resolves
      let evalCount = 0;
      const originalGenerate = llm.generate.bind(llm);
      llm.generate = async (modelId, system, prompt, maxTokens) => {
        if (system.includes("evaluating whether")) {
          evalCount++;
          if (evalCount >= 2) {
            return JSON.stringify({
              allCriteriaMet: true,
              criteriaStatus: [
                { criterion: "EE send() works", met: true, evidence: "Agreed" },
                { criterion: "Status bar correct", met: true, evidence: "Agreed" },
                { criterion: "Data preserved", met: true, evidence: "Agreed" },
                { criterion: "Tests pass", met: true, evidence: "Will verify post-implementation" },
              ],
              unresolvedPoints: [],
              needsResearch: false,
              shouldContinue: false,
              reason: "All criteria addressed, agreed on version-first approach",
            });
          }
        }
        return originalGenerate(modelId, system, prompt, maxTokens);
      };

      let qIdx = 0;
      const gen = runCouncil(
        "EE core không hoạt động, cần điều tra và fix",
        "deepseek-chat",
        [
          { role: "user", content: "hiện tại đang có vấn đề là cli này đang không dùng được ee core" },
          { role: "user", content: "EE core không hoạt động, cần điều tra và fix" },
        ],
        "test-session-3",
        llm,
        (_qid) => {
          qIdx++;
          return Promise.resolve(
            qIdx === 1
              ? "send() fails với undefined, ECONNREFUSED port 9876"
              : "Sau khi update lên version mới, trước đó hoạt động bình thường",
          );
        },
        (_pid) => Promise.resolve(true),
        async function* () {
          yield { type: "content" as const, content: "Implementing fixes..." };
        },
      );

      const { chunks } = await collectChunks(gen);
      const content = getContent(chunks);

      // Should have research phase (complex problem needs codebase investigation)
      expect(content).toContain("Research");
      expect(content).toContain("src/ee/client.ts");

      // Should have multiple rounds (first evaluation says shouldContinue=true)
      expect(content).toContain("Discussion Round 1");
      expect(content).toContain("Discussion Round 2");

      // Leader should eventually stop
      expect(content).toContain("debate sufficient");

      // Should have plan with action items
      expect(content).toContain("Synthesis");
    });
  });

  // ── Case 4: Skip clarification — auto-council from PIL ────────────────────
  // Real-world: user types a clear planning prompt, PIL auto-triggers council
  describe("Case 4: Auto-council — skipClarification for clear prompts", () => {
    it("should skip clarification but still show preflight", async () => {
      const llm = createMockLLM({
        _researchNeed: '{"needsResearch":false,"reason":"Planning discussion"}',
      });

      const gen = runCouncil(
        "Plan the authentication system with JWT, refresh tokens, and role-based access control",
        "deepseek-chat",
        [{ role: "user", content: "Plan the authentication system with JWT, refresh tokens, and RBAC" }],
        "test-session-4",
        llm,
        (_qid) => Promise.resolve("N/A"),
        (_pid) => Promise.resolve(true),
        async function* () {
          yield { type: "content" as const, content: "ok" };
        },
        { skipClarification: true },
      );

      const { chunks } = await collectChunks(gen);
      const content = getContent(chunks);
      const questions = getQuestions(chunks);
      const preflights = getPreflights(chunks);

      // No clarification questions (skipped)
      expect(questions.length).toBe(0);
      expect(content).toContain("skipping clarification");

      // But still has preflight
      expect(preflights.length).toBeGreaterThan(0);

      // Has debate
      expect(content).toContain("Opening Analysis");
    });
  });

  // ── Case 5: Preflight rejection — user says no ────────────────────────────
  // Real-world: user reviews the brief and wants to change scope
  describe("Case 5: Preflight rejection — loop back to clarification", () => {
    it("should loop back when user rejects preflight", async () => {
      let preflightCallCount = 0;
      let clarifyCallCount = 0;

      const llm = createMockLLM({
        _clarify: "[]", // No questions needed
        _researchNeed: '{"needsResearch":false}',
      });

      // Override clarify to track calls
      const origGenerate = llm.generate.bind(llm);
      llm.generate = async (modelId, system, prompt, maxTokens) => {
        if (system.includes("preparing for a multi-expert discussion")) {
          clarifyCallCount++;
          if (clarifyCallCount === 1) {
            return JSON.stringify([{ question: "What's the scope?", why: "Need scope", isRequired: true }]);
          }
          return "[]"; // Second time, no more questions
        }
        return origGenerate(modelId, system, prompt, maxTokens);
      };

      const gen = runCouncil(
        "Refactor the payment module",
        "deepseek-chat",
        [],
        "test-session-5",
        llm,
        (_qid) => Promise.resolve("Only the payment processing, not billing"),
        (_pid) => {
          preflightCallCount++;
          // Reject first time, approve second
          return Promise.resolve(preflightCallCount >= 2);
        },
        async function* () {
          yield { type: "content" as const, content: "ok" };
        },
      );

      const { chunks } = await collectChunks(gen);
      const content = getContent(chunks);

      // Should have gone through clarification twice
      expect(clarifyCallCount).toBeGreaterThanOrEqual(2);

      // First preflight rejected
      expect(content).toContain("rejected");

      // Second preflight approved
      expect(content).toContain("approved");

      // Debate happened after approval
      expect(content).toContain("Opening Analysis");
    });
  });
});
