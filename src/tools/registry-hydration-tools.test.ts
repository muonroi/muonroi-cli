import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetArtifactCacheForTests, recordArtifact } from "../ee/artifact-cache.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools, MAX_TOOL_OUTPUT_CHARS } from "./registry.js";

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

  it("allows plan/ask to rehydrate evidence without exposing workspace mutation tools", () => {
    for (const mode of ["plan", "ask"] as const) {
      const tools = createBuiltinTools(new BashTool(os.tmpdir()), mode);
      expect(tools.retrieve_tool_result).toBeDefined();
      expect(tools.search_session_history).toBeDefined();
      expect(tools.write_file).toBeUndefined();
      expect(tools.edit_file).toBeUndefined();
    }
  });
});

describe("retrieve_tool_result tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetArtifactCacheForTests();
  });

  it("discovers bounded local evidence IDs without needing an ID or EE", async () => {
    mockGetSessionChain.mockReturnValue(["session_root", "session_child"]);
    const all = vi.fn().mockReturnValue([
      {
        tool_call_id: "call_complete_identifier",
        session_id: "session_child",
        tool_name: "delegation_read",
        result_available: 1,
      },
    ]);
    mockPrepare.mockReturnValue({ all });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { sessionId: "session_child" })
      .retrieve_tool_result as ToolWithExecute;
    const response = JSON.parse(String(await tool.execute?.({ view: "index", query: "PLAN.md" })));
    expect(response.view).toBe("index");
    expect(response.entries[0].tool_call_id).toBe("call_complete_identifier");
    expect(response.entries[0].retrieve).toEqual({ tool_call_id: "call_complete_identifier" });
    expect(response.entries[0]).not.toHaveProperty("content");
    expect(response.entries[0]).not.toHaveProperty("args_json");
    expect(all).toHaveBeenCalled();
    expect(mockSearchEE).not.toHaveBeenCalled();
  });

  it("returns complete candidate references on a truncated-ID miss without reading their content", async () => {
    const full = "call_f56f2b2b980c4ea7861f126c";
    mockGetSessionChain.mockReturnValue(["session_root"]);
    mockPrepare.mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([
        { tool_call_id: full, session_id: "session_root", tool_name: "delegation_read", result_available: 1 },
        { tool_call_id: "call_f56f2b2_other", session_id: "session_root", tool_name: "read_file", result_available: 1 },
      ]),
    });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { sessionId: "session_root" })
      .retrieve_tool_result as ToolWithExecute;
    const response = String(await tool.execute?.({ tool_call_id: "call_f56f2b2" }));
    expect(response).toContain("not found");
    expect(response).toContain(full);
    expect(response).toContain("call_f56f2b2_other");
    expect(response).toContain('"retrieve"');
    expect(response).not.toContain('"content"');
    expect(mockSearchEE).not.toHaveBeenCalled();
  });

  it("does not discover unbound sessions or treat an invalid index page as a content request", async () => {
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "agent").retrieve_tool_result as ToolWithExecute;
    expect(String(await tool.execute?.({ view: "index" }))).toContain("session");
    expect(String(await tool.execute?.({ view: "index", chunk_index: -1 }))).toContain("chunk_index");
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockSearchEE).not.toHaveBeenCalled();
  });

  it("recovers bounded original arguments from the owning session family instead of output caches", async () => {
    recordArtifact("call-original", "bash", "cached output is not arguments");
    mockGetSessionChain.mockReturnValue(["session_root", "session_child"]);
    const get = vi.fn().mockReturnValue({ output_json: JSON.stringify({ command: "x".repeat(6000) }) });
    mockPrepare.mockReturnValue({ get });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask", { sessionId: "session_child" })
      .retrieve_tool_result as ToolWithExecute;
    const response = JSON.parse(String(await tool.execute?.({ tool_call_id: "call-original", view: "arguments" })));
    expect(response.view).toBe("arguments");
    expect(response.content).not.toContain("cached output");
    expect(response.content.length).toBeLessThanOrEqual(4000);
    expect(response.total_chunks).toBeGreaterThan(1);
    expect(get).toHaveBeenCalledWith("call-original", "session_child");
    expect(mockSearchEE).not.toHaveBeenCalled();
  });

  it("reports when only an old marker was stored instead of fabricating original arguments", async () => {
    mockGetSessionChain.mockReturnValue(["session_root"]);
    mockPrepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_json: JSON.stringify({
          __elided_note: "[earlier call args elided by sub-agent compactor — 500 chars]",
        }),
      }),
    });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask", { sessionId: "session_root" })
      .retrieve_tool_result as ToolWithExecute;
    expect(String(await tool.execute?.({ tool_call_id: "lost-original", view: "arguments" }))).toContain(
      "original arguments were not retained",
    );
    expect(mockSearchEE).not.toHaveBeenCalled();
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

  it("does not substitute a semantic EE lesson for a missing exact tool result", async () => {
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
    expect(String(res)).toContain("not found");
    expect(String(res)).toContain("delegation_read");
    expect(String(res)).not.toContain("Remote EE Content");
    expect(mockSearchEE).not.toHaveBeenCalled();
  });

  it("keeps exact EE artifact lookup separate from semantic lesson recall", async () => {
    mockSearchEE.mockResolvedValue({ points: [{ text: "Unrelated provider lesson" }] });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "agent").ee_query as ToolWithExecute;
    const result = String(await tool.execute?.({ query: "tool-artifact id=missing-peer-call" }));
    expect(result).toContain("not found");
    expect(result).not.toContain("Unrelated provider lesson");
    expect(mockSearchEE).not.toHaveBeenCalled();
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
  it("rejects standalone FTS wildcards before SQLite without widening the query", async () => {
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask").search_session_history as ToolWithExecute;
    for (const query of ["*", "  ***  "]) {
      const response = String(await tool.execute?.({ query, query_mode: "fts" }));
      expect(response).toContain("unsupported_fts_wildcard");
      expect(response).toContain("term*");
    }
    expect(mockPrepare).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("quotes literal punctuation as an FTS phrase while preserving the original query in the response", async () => {
    const all = vi.fn().mockReturnValue([
      {
        session_id: "history",
        seq: 1,
        role: "user",
        content: 'auto-edit "safe"',
        tool_name: null,
        tool_args: null,
        tool_output: null,
      },
    ]);
    mockPrepare.mockReturnValue({ all });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask").search_session_history as ToolWithExecute;
    const response = JSON.parse(String(await tool.execute?.({ query: 'auto-edit "safe"', query_mode: "literal" })));
    expect(all).toHaveBeenCalledWith('"auto-edit ""safe"""', 0);
    expect(response.query).toBe('auto-edit "safe"');
    expect(response.query_mode).toBe("literal");
  });

  it("bounds historical tool blobs as valid JSON excerpts with omission metadata", async () => {
    const blob = 'history \\" nested result \\n'.repeat(4000);
    mockPrepare.mockReturnValue({
      all: vi.fn().mockReturnValue(
        Array.from({ length: 50 }, (_, i) => ({
          session_id: "history-session",
          seq: i,
          role: "tool",
          tool_name: "bash",
          content: blob,
          tool_args: blob,
          tool_output: blob,
        })),
      ),
    });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask").search_session_history as ToolWithExecute;
    const output = String(await tool.execute?.({ query: "history" }));
    expect(output.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    const parsed = JSON.parse(output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.match_count).toBe(50);
    expect(parsed.returned_count).toBe(parsed.results.length);
    expect(parsed.results[0].session_id).toBe("history-session");
    expect(parsed.results[0].truncated_fields.tool_output).toBe(blob.length);
    expect(parsed.results[0].tool_output.length).toBeLessThan(blob.length);
    expect(parsed.next_offset).toBeGreaterThan(0);
  });

  it("uses the returned offset to page through remaining FTS matches", async () => {
    const all = vi.fn().mockReturnValue([
      {
        session_id: "history",
        seq: 9,
        role: "user",
        tool_name: null,
        content: "history",
        tool_args: null,
        tool_output: null,
      },
    ]);
    mockPrepare.mockReturnValue({ all });
    const tool = createBuiltinTools(new BashTool(os.tmpdir()), "ask").search_session_history as ToolWithExecute;
    const response = JSON.parse(String(await tool.execute?.({ query: "history", offset: 8 })));
    expect(all).toHaveBeenCalledWith("history", 8);
    expect(response.results[0].seq).toBe(9);
    expect(response.next_offset).toBeNull();
    expect(await tool.execute?.({ query: "history", offset: -1 })).toContain("ERROR");
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
