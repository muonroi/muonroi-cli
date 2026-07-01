import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetArtifactCacheForTests, recordArtifact } from "../ee/artifact-cache.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

interface ToolWithExecute {
  execute?: (input: unknown) => Promise<unknown> | unknown;
}

// Set up mocks
const mockPrepare = vi.fn();
vi.mock("../storage/db.js", () => ({
  getDatabase: () => ({
    prepare: mockPrepare,
  }),
}));

const mockGetSessionChain = vi.fn();
vi.mock("../storage/index.js", () => ({
  getSessionChain: mockGetSessionChain,
}));

const mockSearchEE = vi.fn();
vi.mock("../ee/search.js", () => ({
  searchEE: mockSearchEE,
}));

describe("hydration tools registration", () => {
  it("registers retrieve_tool_result and search_session_history in agent mode", () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    expect(tools.retrieve_tool_result).toBeDefined();
    expect(tools.search_session_history).toBeDefined();
  });

  it("does NOT register retrieve_tool_result or search_session_history in plan/ask mode", () => {
    const planTools = createBuiltinTools(new BashTool(os.tmpdir()), "plan");
    expect(planTools.retrieve_tool_result).toBeUndefined();
    expect(planTools.search_session_history).toBeUndefined();
  });
});

describe("retrieve_tool_result tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetArtifactCacheForTests();
  });

  it("checks Tier 1 (LRU cache) first", async () => {
    recordArtifact("call_test_1", "grep", "Tier 1 LRU Content");

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const tool = tools.retrieve_tool_result as ToolWithExecute;
    const res = await tool.execute?.({ tool_call_id: "call_test_1" });
    const parsed = JSON.parse(String(res));

    expect(parsed.tool_call_id).toBe("call_test_1");
    expect(parsed.source).toBe("Tier 1 LRU cache");
    expect(parsed.content).toBe("Tier 1 LRU Content");
  });

  it("checks Tier 3 (Database) when Tier 1/2 are missing", async () => {
    mockGetSessionChain.mockReturnValue(["session_root", "session_child"]);
    const mockGet = vi.fn().mockReturnValue({
      output_json: JSON.stringify({
        success: true,
        output: "Database Output",
      }),
    });
    mockPrepare.mockReturnValue({
      get: mockGet,
    });

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", {
      sessionId: "session_child",
    });
    const tool = tools.retrieve_tool_result as ToolWithExecute;
    const res = await tool.execute?.({ tool_call_id: "call_db_1" });
    const parsed = JSON.parse(String(res));

    expect(parsed.tool_call_id).toBe("call_db_1");
    expect(parsed.source).toContain("Tier 3 SQLite database");
    expect(parsed.content).toBe("Database Output");
    expect(mockPrepare).toHaveBeenCalled();
  });

  it("checks Tier 4 (Experience Engine) when others are missing", async () => {
    mockSearchEE.mockResolvedValue({
      points: [
        {
          text: "Remote EE Content",
        },
      ],
    });

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const tool = tools.retrieve_tool_result as ToolWithExecute;
    const res = await tool.execute?.({ tool_call_id: "call_ee_1" });
    const parsed = JSON.parse(String(res));

    expect(parsed.tool_call_id).toBe("call_ee_1");
    expect(parsed.source).toContain("Tier 4 remote EE");
    expect(parsed.content).toBe("Remote EE Content");
  });

  it("supports character limits and chunking", async () => {
    recordArtifact("call_chunk_1", "bash", "ABCDEFGHIJ"); // 10 chars

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const tool = tools.retrieve_tool_result as ToolWithExecute;

    // Chunk 0: max_chars=4
    const res0 = await tool.execute?.({ tool_call_id: "call_chunk_1", max_chars: 4, chunk_index: 0 });
    const parsed0 = JSON.parse(String(res0));
    expect(parsed0.content).toBe("ABCD");
    expect(parsed0.chunk_index).toBe(0);
    expect(parsed0.total_chunks).toBe(3);

    // Chunk 1: max_chars=4
    const res1 = await tool.execute?.({ tool_call_id: "call_chunk_1", max_chars: 4, chunk_index: 1 });
    const parsed1 = JSON.parse(String(res1));
    expect(parsed1.content).toBe("EFGH");
    expect(parsed1.chunk_index).toBe(1);

    // Chunk 2: max_chars=4
    const res2 = await tool.execute?.({ tool_call_id: "call_chunk_1", max_chars: 4, chunk_index: 2 });
    const parsed2 = JSON.parse(String(res2));
    expect(parsed2.content).toBe("IJ");
    expect(parsed2.chunk_index).toBe(2);
  });
});

describe("search_session_history tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns search results from FTS table", async () => {
    const mockAll = vi.fn().mockReturnValue([
      {
        session_id: "sess_1",
        seq: 1,
        role: "user",
        tool_name: null,
        content: "I want to deploy",
        tool_args: null,
        tool_output: null,
      },
    ]);
    mockPrepare.mockReturnValue({
      all: mockAll,
    });

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const tool = tools.search_session_history as ToolWithExecute;
    const res = await tool.execute?.({ query: "deploy" });
    const parsed = JSON.parse(String(res));

    expect(parsed.query).toBe("deploy");
    expect(parsed.match_count).toBe(1);
    expect(parsed.results[0].content).toBe("I want to deploy");
  });

  it("handles malformed MATCH expression gracefully", async () => {
    mockPrepare.mockImplementation(() => {
      throw new Error('fts5: syntax error near "*"');
    });

    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent");
    const tool = tools.search_session_history as ToolWithExecute;
    const res = await tool.execute?.({ query: "deploy*" });

    expect(res).toContain("ERROR");
    expect(res).toContain("syntax error");
  });
});
