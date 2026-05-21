/**
 * src/reporter/__tests__/handlers.test.ts
 *
 * Tests for reporter handler functions.
 * Mocks backlog-store, sprint-store, progress-snapshot, and budget modules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilLLM } from "../../council/types.js";
import type { ReporterDeps } from "../handlers.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../product-loop/progress-snapshot.js", () => ({
  computeProgressSnapshot: vi.fn(),
  renderSnapshotMarkdown: vi.fn(),
}));

vi.mock("../../product-loop/backlog-store.js", () => ({
  readBacklog: vi.fn(),
}));

vi.mock("../../product-loop/sprint-store.js", () => ({
  readSprintPlan: vi.fn(),
}));

vi.mock("../budget.js", () => ({
  getReporterDailySpend: vi.fn(),
  recordReporterSpend: vi.fn(),
}));

vi.mock("../../council/leader.js", () => ({
  pickCouncilTaskModel: vi.fn().mockReturnValue("mock-fast-model"),
}));

import { pickCouncilTaskModel } from "../../council/leader.js";
import { readBacklog } from "../../product-loop/backlog-store.js";
import { computeProgressSnapshot, renderSnapshotMarkdown } from "../../product-loop/progress-snapshot.js";
import { readSprintPlan } from "../../product-loop/sprint-store.js";
import { getReporterDailySpend, recordReporterSpend } from "../budget.js";
import { handleFreeformQuery, handleItemQuery, handleProgressQuery, handleSprintQuery } from "../handlers.js";

const mockComputeSnapshot = computeProgressSnapshot as ReturnType<typeof vi.fn>;
const mockRenderSnapshot = renderSnapshotMarkdown as ReturnType<typeof vi.fn>;
const mockReadBacklog = readBacklog as ReturnType<typeof vi.fn>;
const mockReadSprintPlan = readSprintPlan as ReturnType<typeof vi.fn>;
const mockGetSpend = getReporterDailySpend as ReturnType<typeof vi.fn>;
const mockRecordSpend = recordReporterSpend as ReturnType<typeof vi.fn>;
const mockPickModel = pickCouncilTaskModel as ReturnType<typeof vi.fn>;

const mockLlm: CouncilLLM = {
  generate: vi.fn().mockResolvedValue("LLM answer"),
  research: vi.fn(),
  debate: vi.fn(),
};

const deps: ReporterDeps = {
  flowDir: "/fake/.planning",
  runId: "run-001",
  productSlug: "my-product",
  llm: mockLlm,
  leaderModelId: "leader-model",
  dailyBudget: 0.5,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordSpend.mockResolvedValue(undefined);
});

// ─── handleProgressQuery ──────────────────────────────────────────────────────

describe("handleProgressQuery", () => {
  it("returns rendered snapshot markdown containing '## Progress'", async () => {
    const fakeSnapshot = { runId: "run-001", productSlug: "my-product" };
    mockComputeSnapshot.mockResolvedValue(fakeSnapshot);
    mockRenderSnapshot.mockReturnValue("## Progress\n**Backlog:** 5 total");

    const result = await handleProgressQuery(deps);
    expect(result).toContain("## Progress");
    expect(mockComputeSnapshot).toHaveBeenCalledWith({
      flowDir: deps.flowDir,
      runId: deps.runId,
      productSlug: deps.productSlug,
    });
  });
});

// ─── handleSprintQuery ────────────────────────────────────────────────────────

describe("handleSprintQuery", () => {
  it("returns sprint goal when sprint 2 exists", async () => {
    mockReadSprintPlan.mockResolvedValue({
      runId: "run-001",
      sprints: [
        { id: "sprint-1", number: 1, goal: "Auth MVP", itemIds: [], status: "done" },
        { id: "sprint-2", number: 2, goal: "Dashboard MVP", itemIds: ["item-1"], status: "active" },
      ],
      activeSprintId: "sprint-2",
    });
    mockReadBacklog.mockResolvedValue({
      items: [
        {
          id: "item-1",
          title: "Build dashboard",
          status: "in_progress",
          acceptance_criteria: ["it renders"],
          mvp_priority: "v1",
          effortPoints: 3,
          description: "desc",
          entities: [],
          endpoints: [],
          createdAtUtc: "",
          updatedAtUtc: "",
        },
      ],
    });

    const result = await handleSprintQuery(deps, 2);
    expect(result).toContain("Dashboard MVP");
    expect(result).toContain("Build dashboard");
  });

  it("returns 'Sprint 99 not found' when sprint does not exist", async () => {
    mockReadSprintPlan.mockResolvedValue({
      runId: "run-001",
      sprints: [{ id: "sprint-1", number: 1, goal: "Auth", itemIds: [], status: "done" }],
      activeSprintId: null,
    });
    mockReadBacklog.mockResolvedValue({ items: [] });

    const result = await handleSprintQuery(deps, 99);
    expect(result).toContain("99");
    expect(result.toLowerCase()).toContain("not found");
  });
});

// ─── handleItemQuery ──────────────────────────────────────────────────────────

describe("handleItemQuery", () => {
  it("returns item details including acceptance criteria when a single item matches", async () => {
    mockReadBacklog.mockResolvedValue({
      items: [
        {
          id: "item-login",
          title: "Login feature",
          description: "User authentication flow",
          acceptance_criteria: ["User can log in with email+password", "Session persists 7 days"],
          mvp_priority: "v1",
          status: "backlog",
          effortPoints: 3,
          entities: [],
          endpoints: [],
          createdAtUtc: "",
          updatedAtUtc: "",
        },
      ],
    });

    const result = await handleItemQuery(deps, "login");
    expect(result).toContain("Login feature");
    expect(result).toContain("User can log in with email+password");
  });
});

// ─── handleFreeformQuery ──────────────────────────────────────────────────────

describe("handleFreeformQuery", () => {
  it("returns budget exhausted message + snapshot fallback when budget exceeded", async () => {
    mockGetSpend.mockResolvedValue(0.55); // > dailyBudget=0.50
    const fakeSnapshot = { runId: "run-001", productSlug: "my-product" };
    mockComputeSnapshot.mockResolvedValue(fakeSnapshot);
    mockRenderSnapshot.mockReturnValue("## Progress snapshot");

    const result = await handleFreeformQuery(deps, "what is the architecture?");
    expect(result).toContain("budget exhausted");
    expect(result).toContain("## Progress snapshot");
  });

  it("calls pickCouncilTaskModel with 'reporter_qa' when under budget", async () => {
    mockGetSpend.mockResolvedValue(0.1); // < dailyBudget=0.50
    mockComputeSnapshot.mockResolvedValue({ runId: "run-001" });
    mockRenderSnapshot.mockReturnValue("");
    mockReadBacklog.mockResolvedValue(null);
    mockReadSprintPlan.mockResolvedValue(null);
    (mockLlm.generate as ReturnType<typeof vi.fn>).mockResolvedValue("LLM free-form answer");

    const result = await handleFreeformQuery(deps, "what is the architecture?");
    expect(mockPickModel).toHaveBeenCalledWith("reporter_qa", deps.leaderModelId, true);
    expect(result).toBe("LLM free-form answer");
  });
});
