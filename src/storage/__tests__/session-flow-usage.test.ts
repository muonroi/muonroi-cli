/**
 * Regression: a resumed chat that never wrote a todo came back with a pinned
 * checklist. The checklist is parsed from `.planning/PLAN.md` — a CWD-owned
 * file — so every session opened in a repo that had ever run FLOW inherited
 * someone else's finished plan. The restore has to be session-scoped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const toolCallsBySession = new Map<string, string[]>();
let lastSql = "";

// Minimal stand-in for the session chain + tool_calls lookups: a single
// parentless session whose tool calls come from `toolCallsBySession`.
vi.mock("../db", () => ({
  getDatabase: () => ({
    prepare: (sql: string) => {
      lastSql = sql.toLowerCase();
      return {
        get: (sessionId: string) => {
          if (lastSql.includes("like 'flow")) {
            const names = toolCallsBySession.get(sessionId) ?? [];
            return names.some((n) => /^(flow|gsd)_/.test(n)) ? { hit: 1 } : undefined;
          }
          return undefined; // no parent_session_id — this session IS the root
        },
        all: (...params: string[]) => (lastSql.includes("order by created_at") ? params.map((id) => ({ id })) : []),
      };
    },
  }),
}));

vi.mock("../transcript-view", () => ({ buildEffectiveTranscript: () => ({ messages: [], seqs: [] }) }));

import { sessionUsedFlowWorkflow } from "../transcript";

beforeEach(() => {
  toolCallsBySession.clear();
});

describe("sessionUsedFlowWorkflow", () => {
  it("is false for a plain chat session — the CWD plan is not its checklist", () => {
    toolCallsBySession.set("s1", ["bash", "read", "edit"]);
    expect(sessionUsedFlowWorkflow("s1")).toBe(false);
  });

  it("is false when the session made no tool calls at all", () => {
    expect(sessionUsedFlowWorkflow("s-empty")).toBe(false);
  });

  it("is true once the session actually drove the FLOW workflow", () => {
    toolCallsBySession.set("s2", ["bash", "flow_plan"]);
    expect(sessionUsedFlowWorkflow("s2")).toBe(true);
  });
  it("recognizes historical calls without registering old executable tool aliases", () => {
    toolCallsBySession.set("historical", ["gsd_plan"]);
    expect(sessionUsedFlowWorkflow("historical")).toBe(true);
  });

  it("does not treat a merely flow-shaped tool name as a workflow call", () => {
    // LIKE 'flow\_%' ESCAPE '\' — the underscore is literal, not a wildcard.
    toolCallsBySession.set("s3", ["flowXplan"]);
    expect(sessionUsedFlowWorkflow("s3")).toBe(false);
  });
});
