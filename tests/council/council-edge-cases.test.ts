import { describe, it, expect, vi } from "vitest";
import { runCouncil } from "../../src/council/index.js";
import type { CouncilLLM } from "../../src/council/types.js";
import type { StreamChunk } from "../../src/types/index.js";

vi.mock("../../src/council/leader.js", () => ({
  resolveLeaderModel: () => "mock-premium",
  resolveLeaderModelDetailed: async () => ({ modelId: "mock-premium" }),
  resolveParticipants: async () => [
    { role: "implement", model: "mock-balanced" },
    { role: "verify", model: "mock-premium" },
  ],
  hasMultiProviderConfig: () => false,
}));

vi.mock("../../src/orchestrator/agent-options.js", () => ({
  COUNCIL_ROLE_COLORS: { implement: "", verify: "", research: "", leader: "" },
  COUNCIL_COLOR_RESET: "",
  COUNCIL_COLOR_BG: { implement: "", verify: "", research: "", leader: "" },
}));

vi.mock("../../src/storage/index.js", () => ({
  appendSystemMessage: vi.fn(),
  logInteraction: vi.fn(),
}));

vi.mock("../../src/utils/settings.js", () => ({
  getRoleModel: () => undefined,
  getRoleModels: () => ({}),
  isCouncilMultiProviderPreferred: () => false,
  loadUserSettings: () => ({}),
  getCouncilExperienceMode: () => "advisory",
}));

vi.mock("../../src/pil/pipeline.js", () => ({
  runPipeline: async () => null,
}));

vi.mock("../../src/ee/council-bridge.js", () => ({
  queryExperience: async () => ({ warnings: [] }),
}));

async function collectChunks(gen: AsyncGenerator<StreamChunk, string | null, unknown>) {
  const chunks: StreamChunk[] = [];
  let res: IteratorResult<StreamChunk, string | null>;
  do {
    res = await gen.next();
    if (!res.done && res.value) chunks.push(res.value);
  } while (!res.done);
  return { chunks, result: res.value };
}

function getContent(chunks: StreamChunk[]): string {
  return chunks.filter((c) => c.type === "content").map((c) => c.content ?? "").join("");
}

describe("Council Edge Cases", () => {
  // ── Leader luôn evaluate, không phải speaker tự đánh giá ───────────────────
  it("leader evaluates debate, not speakers evaluating themselves", async () => {
    let evaluationModelId = "";
    const llm: CouncilLLM = {
      async generate(modelId, system, _prompt, _max) {
        if (system.includes("evaluating whether")) {
          evaluationModelId = modelId;
          return JSON.stringify({
            allCriteriaMet: true,
            criteriaStatus: [{ criterion: "test", met: true, evidence: "ok" }],
            unresolvedPoints: [],
            needsResearch: false,
            shouldContinue: false,
            reason: "Done",
          });
        }
        if (system.includes("identify AMBIGUITIES")) return "[]";
        if (system.includes("synthesizing")) return '{"problemStatement":"test","constraints":[],"successCriteria":["test"],"scope":"test"}';
        if (system.includes("research phase")) return '{"needsResearch":false}';
        if (system.includes("team lead")) return '{"type":"decision","summary":"Done","agreed":[],"tradeoffs":[],"recommendation":"A"}\n---READABLE---\n## AGREED\nDone';
        if (system.includes("Summarize")) return "- Summary";
        return "I think approach A is better because of performance.";
      },
      async research() { return "## Research\n- N/A"; },
    };

    const gen = runCouncil(
      "Choose between Redis and Memcached for caching",
      "mock-balanced",
      [],
      "test-edge-1",
      llm,
      () => Promise.resolve("session cache, ~10k keys"),
      () => Promise.resolve(true),
      async function* () { yield { type: "content" as const, content: "ok" }; },
      { skipClarification: true },
    );

    await collectChunks(gen);

    // The evaluation model should be the LEADER (premium), not a speaker
    expect(evaluationModelId).toBe("mock-premium");
  });

  // ── Safety valve: debate capped at 8 rounds ────────────────────────────────
  it("debate stops at safety valve even if leader says continue", async () => {
    let roundsSeen = 0;
    const llm: CouncilLLM = {
      async generate(_modelId, system, _prompt, _max) {
        if (system.includes("evaluating whether")) {
          return JSON.stringify({
            allCriteriaMet: false,
            criteriaStatus: [],
            unresolvedPoints: ["never resolves"],
            needsResearch: false,
            shouldContinue: true, // Always says continue
            reason: "Not resolved yet",
          });
        }
        if (system.includes("identify AMBIGUITIES")) return "[]";
        if (system.includes("synthesizing")) return '{"problemStatement":"infinite debate","constraints":[],"successCriteria":["never met"],"scope":"test"}';
        if (system.includes("research phase")) return '{"needsResearch":false}';
        if (system.includes("team lead")) return '{"type":"decision","summary":"Forced stop","agreed":[],"tradeoffs":[],"recommendation":"A"}\n---READABLE---\n## Done';
        if (system.includes("Summarize")) return "- Still debating";
        if (system.includes("continuing a discussion")) {
          roundsSeen++;
          return "I still disagree. Let me explain further...";
        }
        return "My analysis...";
      },
      async research() { return "## Research\n- N/A"; },
    };

    const gen = runCouncil(
      "Impossible to resolve topic",
      "mock-balanced",
      [],
      "test-edge-2",
      llm,
      () => Promise.resolve("N/A"),
      () => Promise.resolve(true),
      async function* () { yield { type: "content" as const, content: "ok" }; },
      { skipClarification: true },
    );

    const { chunks } = await collectChunks(gen);
    const content = getContent(chunks);

    // Should have Discussion Round 8 (max) but NOT round 9
    expect(content).toContain("Discussion Round 8");
    expect(content).not.toContain("Discussion Round 9");
  });

  // ── Mid-debate research triggered by leader ────────────────────────────────
  it("leader can trigger mid-debate research when stuck on facts", async () => {
    let evalCount = 0;
    let researchCalled = false;

    const llm: CouncilLLM = {
      async generate(_modelId, system, _prompt, _max) {
        if (system.includes("evaluating whether")) {
          evalCount++;
          if (evalCount === 1) {
            return JSON.stringify({
              allCriteriaMet: false,
              criteriaStatus: [{ criterion: "test", met: false, evidence: "need data" }],
              unresolvedPoints: ["Missing codebase facts"],
              needsResearch: true,
              researchQuery: "Check src/auth/ for existing JWT implementation",
              shouldContinue: true,
              reason: "Need codebase research to proceed",
            });
          }
          return JSON.stringify({
            allCriteriaMet: true,
            criteriaStatus: [{ criterion: "test", met: true, evidence: "resolved with research" }],
            unresolvedPoints: [],
            needsResearch: false,
            shouldContinue: false,
            reason: "Research resolved the open question",
          });
        }
        if (system.includes("identify AMBIGUITIES")) return "[]";
        if (system.includes("synthesizing")) return '{"problemStatement":"test","constraints":[],"successCriteria":["test"],"scope":"test"}';
        if (system.includes("research phase")) return '{"needsResearch":false}';
        if (system.includes("team lead")) return '{"type":"decision","summary":"Done","agreed":[],"tradeoffs":[],"recommendation":"A"}\n---READABLE---\nDone';
        if (system.includes("Summarize")) return "- Summary";
        return "My analysis based on what we know...";
      },
      async research(_modelId, topic) {
        researchCalled = true;
        return `## Research Findings\n- Found JWT impl in src/auth/jwt.ts\n- Uses RS256 with 1h expiry\n## Gaps\n- None`;
      },
    };

    const gen = runCouncil(
      "Add refresh token rotation to auth system",
      "mock-balanced",
      [],
      "test-edge-3",
      llm,
      () => Promise.resolve("N/A"),
      () => Promise.resolve(true),
      async function* () { yield { type: "content" as const, content: "ok" }; },
      { skipClarification: true },
    );

    const { chunks } = await collectChunks(gen);
    const content = getContent(chunks);

    // Mid-debate research should have been triggered
    expect(researchCalled).toBe(true);
    expect(content).toContain("Mid-debate Research");
    expect(content).toContain("JWT impl in src/auth/jwt.ts");
  });

  // ── Spec captures clarification answers accurately ─────────────────────────
  it("clarified spec is built from actual user answers", async () => {
    let specPromptReceived = "";
    const llm: CouncilLLM = {
      async generate(_modelId, system, prompt, _max) {
        if (system.includes("identify AMBIGUITIES")) {
          return JSON.stringify([
            { question: "Dùng database nào?", why: "Ảnh hưởng query pattern", isRequired: true },
          ]);
        }
        if (system.includes("synthesizing a discussion brief")) {
          specPromptReceived = prompt;
          return JSON.stringify({
            problemStatement: "Optimize PostgreSQL queries for user dashboard",
            constraints: ["PostgreSQL 15", "< 200ms response time"],
            successCriteria: ["Query time < 200ms", "No N+1 queries"],
            scope: "User dashboard API endpoints",
          });
        }
        if (system.includes("research phase")) return '{"needsResearch":false}';
        if (system.includes("evaluating")) return '{"allCriteriaMet":true,"criteriaStatus":[],"unresolvedPoints":[],"needsResearch":false,"shouldContinue":false,"reason":"Done"}';
        if (system.includes("team lead")) return '{"type":"decision","summary":"Done","agreed":[],"tradeoffs":[],"recommendation":"A"}\n---READABLE---\nDone';
        if (system.includes("Summarize")) return "- ok";
        return "Analysis...";
      },
      async research() { return "N/A"; },
    };

    const gen = runCouncil(
      "Optimize database queries",
      "mock-balanced",
      [],
      "test-edge-4",
      llm,
      (_qid) => Promise.resolve("PostgreSQL 15, cần < 200ms"),
      () => Promise.resolve(true),
      async function* () { yield { type: "content" as const, content: "ok" }; },
    );

    const { chunks } = await collectChunks(gen);
    const content = getContent(chunks);

    // Spec synthesis prompt should contain the user's actual answer
    expect(specPromptReceived).toContain("PostgreSQL 15");
    expect(specPromptReceived).toContain("200ms");

    // Content should show the clarified spec
    expect(content).toContain("PostgreSQL");
  });

  // ── Council outcome persisted to session ───────────────────────────────────
  it("persists council outcome and memory to session DB", async () => {
    const { appendSystemMessage } = await import("../../src/storage/index.js");
    const mockAppend = appendSystemMessage as ReturnType<typeof vi.fn>;
    mockAppend.mockClear();

    const llm: CouncilLLM = {
      async generate(_modelId, system, _prompt, _max) {
        if (system.includes("identify AMBIGUITIES")) return "[]";
        // Order matters: "team lead synthesizing..." also contains "synthesizing",
        // so the team-lead check has to win before the spec-synth check.
        if (system.includes("team lead")) return '{"type":"decision","summary":"Use approach A","agreed":["speed"],"tradeoffs":["complexity"],"recommendation":"A","plan":{"steps":[],"estimatedComplexity":"moderate","prerequisites":[]}}\n---READABLE---\n## Done\nUse A';
        if (system.includes("synthesizing")) return '{"problemStatement":"test","constraints":[],"successCriteria":["test"],"scope":"test"}';
        if (system.includes("research phase")) return '{"needsResearch":false}';
        if (system.includes("evaluating")) return '{"allCriteriaMet":true,"criteriaStatus":[],"unresolvedPoints":[],"needsResearch":false,"shouldContinue":false,"reason":"Done"}';
        if (system.includes("Summarize")) return "ok";
        return "Analysis...";
      },
      async research() { return "N/A"; },
    };

    const gen = runCouncil(
      "Quick decision test",
      "mock-balanced",
      [],
      "persist-test-session",
      llm,
      () => Promise.resolve("N/A"),
      () => Promise.resolve(true),
      async function* () { yield { type: "content" as const, content: "ok" }; },
      { skipClarification: true },
    );

    await collectChunks(gen);

    // Should have persisted Council Decision, Outcome, and Memory
    const calls = mockAppend.mock.calls;
    const messages = calls.map((c: string[]) => c[1] as string);
    expect(messages.some((m: string) => m.includes("[Council Decision]"))).toBe(true);
    expect(messages.some((m: string) => m.includes("[Council Outcome]"))).toBe(true);
    expect(messages.some((m: string) => m.includes("[Council Memory]"))).toBe(true);
  });
});
