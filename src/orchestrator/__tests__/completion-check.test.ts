import { describe, expect, it } from "vitest";
import {
  buildCompletionFooter,
  checkCompletionClaim,
  findCompletionClaim,
  latestOpenTodos,
} from "../completion-check.js";

const openRoot = {
  root_goal: "Ship the TCIS MCP docs server",
  root_status: "open" as const,
  open_items: ["wave 3: search endpoint", "README"],
};

describe("findCompletionClaim", () => {
  it("finds asserted whole-task completion in English and Vietnamese", () => {
    expect(findCompletionClaim("Everything is done. The server runs.")).toBe("Everything is done.");
    expect(findCompletionClaim("The task is complete.")).toBeTruthy();
    expect(findCompletionClaim("I've completed the whole task.")).toBeTruthy();
    expect(findCompletionClaim("Đã hoàn thành toàn bộ nhiệm vụ.")).toBeTruthy();
  });

  it("ignores partial, conditional, negated, quoted and questioning text", () => {
    for (const text of [
      "Wave 2 landed; wave 3 is next.",
      "Once wave 3 lands, the task is complete.",
      "The task is not complete yet.",
      'The commit message says "all done".',
      "Is everything done?",
      "Worker brave-owl reported the task is complete.",
    ])
      expect(findCompletionClaim(text), text).toBeNull();
  });
});

describe("checkCompletionClaim", () => {
  it("flags a done claim while the pinned root goal still has open items", () => {
    const check = checkCompletionClaim("All done!", openRoot, null);
    expect(check).toMatchObject({ rootGoal: openRoot.root_goal, openItems: openRoot.open_items });
    const footer = buildCompletionFooter(check!);
    expect(footer).toContain("Host completion check");
    expect(footer).toContain("2 open item(s)");
    expect(footer).toContain("wave 3: search endpoint");
  });

  it("flags a done claim while FLOW implementation verification is not recorded_pass", () => {
    const check = checkCompletionClaim("The task is complete.", null, {
      declaredPlanScope: "Parser",
      implementationVerification: "missing",
    });
    expect(buildCompletionFooter(check!)).toContain("implementation verification is missing");
  });

  it("flags a done claim while the latest todo list has unfinished items, without any context_load", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "todo_write",
            input: { todos: [{ subject: "old", status: "pending" }] },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t2",
            toolName: "todo_write",
            input: {
              todos: [
                { subject: "parse", status: "completed" },
                { subject: "wire CLI", status: "in_progress" },
              ],
            },
          },
        ],
      },
    ];
    const todos = latestOpenTodos(messages);
    expect(todos).toEqual(["wire CLI"]);
    expect(buildCompletionFooter(checkCompletionClaim("Everything is done.", null, null, todos)!)).toContain(
      "wire CLI",
    );
  });

  it("stays silent when the ledger agrees or the text claims nothing", () => {
    expect(checkCompletionClaim("All done.", { ...openRoot, open_items: [] }, null)).toBeNull();
    expect(checkCompletionClaim("All done.", { ...openRoot, root_status: "complete" }, null)).toBeNull();
    expect(
      checkCompletionClaim("All done.", null, { declaredPlanScope: "P", implementationVerification: "recorded_pass" }),
    ).toBeNull();
    expect(checkCompletionClaim("Wave 2 landed.", openRoot, null)).toBeNull();
  });
});
