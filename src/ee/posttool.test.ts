import { describe, it, expect, vi } from "vitest";
import type { PostToolPayload } from "./types.js";
import type { JudgeContext } from "./judge.js";

// Mock both intercept and judge modules
const mockPosttool = vi.fn();

vi.mock("./intercept.js", () => ({
  getDefaultEEClient: () => ({
    posttool: mockPosttool,
  }),
}));

vi.mock("./judge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judge.js")>();
  return {
    ...actual,
    fireFeedback: vi.fn(),
  };
});

const mockPayload: PostToolPayload = {
  toolName: "bash",
  toolInput: { command: "ls" },
  outcome: { success: true, exitCode: 0, durationMs: 10 },
  cwd: "/tmp",
  tenantId: "local",
  scope: { kind: "global" },
};

describe("posttool() wrapper", () => {
  it("calls client.posttool with payload", async () => {
    mockPosttool.mockClear();
    const { posttool } = await import("./posttool.js");
    posttool(mockPayload);
    expect(mockPosttool).toHaveBeenCalledOnce();
    expect(mockPosttool).toHaveBeenCalledWith(mockPayload);
  });

  it("calls fireFeedback when judgeCtx provided", async () => {
    mockPosttool.mockClear();
    const { posttool } = await import("./posttool.js");
    const { fireFeedback } = await import("./judge.js");
    const mockFF = fireFeedback as unknown as ReturnType<typeof vi.fn>;
    mockFF.mockClear();

    const ctx: JudgeContext = {
      warningResponse: { decision: "allow", matches: [] },
      toolName: "bash",
      outcome: { success: true, durationMs: 10 },
      cwdMatchedAtPretool: true,
      diffPresent: false,
      tenantId: "local",
    };
    posttool(mockPayload, ctx);
    expect(mockPosttool).toHaveBeenCalledOnce();
    expect(mockFF).toHaveBeenCalledOnce();
    expect(mockFF).toHaveBeenCalledWith(ctx);
  });

  it("does not call fireFeedback when judgeCtx is undefined", async () => {
    mockPosttool.mockClear();
    const { posttool } = await import("./posttool.js");
    const { fireFeedback } = await import("./judge.js");
    const mockFF = fireFeedback as unknown as ReturnType<typeof vi.fn>;
    mockFF.mockClear();

    posttool(mockPayload);
    expect(mockPosttool).toHaveBeenCalledOnce();
    expect(mockFF).not.toHaveBeenCalled();
  });

  it("returns void (B-4 invariant preserved)", async () => {
    mockPosttool.mockClear();
    const { posttool } = await import("./posttool.js");
    const result = posttool(mockPayload);
    expect(result).toBeUndefined();
  });
});
