/**
 * Regression: a resumed chat that never wrote a todo came back with a pinned
 * checklist. The checklist is parsed from `.planning/PLAN.md` — a CWD-owned
 * file — so every session opened in a repo that had ever run GSD inherited
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
          if (lastSql.includes("like 'gsd")) {
            const names = toolCallsBySession.get(sessionId) ?? [];
            return names.some((n) => n.startsWith("gsd_")) ? { hit: 1 } : undefined;
          }
          return undefined; // no parent_session_id — this session IS the root
        },
        all: (...params: string[]) => (lastSql.includes("order by created_at") ? params.map((id) => ({ id })) : []),
      };
    },
  }),
}));

vi.mock("../transcript-view", () => ({ buildEffectiveTranscript: () => ({ messages: [], seqs: [] }) }));

import { sessionUsedGsdWorkflow } from "../transcript";

beforeEach(() => {
  toolCallsBySession.clear();
});

describe("sessionUsedGsdWorkflow", () => {
  it("is false for a plain chat session — the CWD plan is not its checklist", () => {
    toolCallsBySession.set("s1", ["bash", "read", "edit"]);
    expect(sessionUsedGsdWorkflow("s1")).toBe(false);
  });

  it("is false when the session made no tool calls at all", () => {
    expect(sessionUsedGsdWorkflow("s-empty")).toBe(false);
  });

  it("is true once the session actually drove the GSD workflow", () => {
    toolCallsBySession.set("s2", ["bash", "gsd_plan"]);
    expect(sessionUsedGsdWorkflow("s2")).toBe(true);
  });

  it("does not treat a merely gsd-shaped tool name as a workflow call", () => {
    // LIKE 'gsd\_%' ESCAPE '\' — the underscore is literal, not a wildcard.
    toolCallsBySession.set("s3", ["gsdXplan"]);
    expect(sessionUsedGsdWorkflow("s3")).toBe(false);
  });
});
