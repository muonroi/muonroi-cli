/**
 * `ask_user` must not be offered on an unattended turn.
 *
 * MEASURED DEFECT, run `muc2joffe506` sprint 2 (`~/.muonroi-cli/muonroi.db`):
 *
 *   tool_calls   id 3558  session 548913168ae0 (kind='subagent', parent 1756b9775bef)
 *                tool_name 'ask_user'  started_at 2026-09-23T14:50:21.922Z
 *                completed_at 2026-09-24T01:14:10.012Z      ← 10.5 hours later
 *
 * The question it asked, verbatim from `args_json`, is the fixture below. The
 * verify stage's 600s silence budget expired at 14:52:34 while that card sat
 * unanswered, `sprints/2-outcome.json` recorded `verify: "ERROR"`, and the three
 * phases the stage HAD verified were replaced by that one word.
 *
 * The `/ideal` verify stage reaches `createBuiltinTools` through
 * `ctx.processMessageFn` → `processMessage` → `tool-engine.ts:1194`, i.e. as a
 * normal top-level turn, so `deps.askUser` is a live closure and the tool is
 * registered. The scope below is how the one call site that knows the turn is
 * machine-driven says so.
 */

import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { __resetUnattendedTurnForTests, beginUnattendedTurn } from "../orchestrator/unattended-turn.js";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

/** Verbatim from `tool_calls.args_json` of id 3558 (truncated to the first line). */
const REAL_QUESTION =
  "The automated verification pass has completed Phases 1-3 successfully (Docker stack up, all services healthy, /api/health OK). However, Phase 4 browser QA failed because `agent-browser` (the expected browser automation tool) is not installed on this Windows host.";

afterEach(() => {
  __resetUnattendedTurnForTests();
});

describe("ask_user registration — unattended turns", () => {
  it("is registered on a normal (attended) turn", () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", {
      askUser: async () => "a",
    });
    expect(tools.ask_user).toBeDefined();
  });

  it("is ABSENT inside an unattended-turn scope even though a handler is wired", () => {
    const release = beginUnattendedTurn();
    try {
      const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", {
        askUser: async () => "a",
      });
      expect(tools.ask_user).toBeUndefined();
    } finally {
      release();
    }
  });

  it("comes back once the scope is released", () => {
    const release = beginUnattendedTurn();
    release();
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", {
      askUser: async () => "a",
    });
    expect(tools.ask_user).toBeDefined();
  });

  it("cannot be reached with the real question that burned run muc2joffe506's budget", async () => {
    const release = beginUnattendedTurn();
    let asked = false;
    try {
      const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", {
        askUser: async () => {
          asked = true;
          return "a";
        },
      });
      // There is no tool to call, so the handler can never be entered.
      expect(tools.ask_user).toBeUndefined();
      expect(REAL_QUESTION).toContain("agent-browser");
      expect(asked).toBe(false);
    } finally {
      release();
    }
  });
});
