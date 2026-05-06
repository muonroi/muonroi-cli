import type { StreamChunk } from "../types/index.js";
import type { ActionPlan } from "./types.js";

export async function* runExecution(
  plan: ActionPlan,
  processMessage: (message: string) => AsyncGenerator<StreamChunk, void, unknown>,
): AsyncGenerator<StreamChunk, void, unknown> {
  yield { type: "content", content: "\n## Execution\n" };

  const highPriority = plan.steps.filter((s) => s.priority === "high");
  const mediumPriority = plan.steps.filter((s) => s.priority === "medium");
  const lowPriority = plan.steps.filter((s) => s.priority === "low");

  const ordered = [...highPriority, ...mediumPriority, ...lowPriority];

  const taskDescription = ordered.map((s, i) => `${i + 1}. ${s.description}`).join("\n");

  yield { type: "content", content: `\n> Executing ${ordered.length} steps from council plan...\n` };

  const executionPrompt =
    `Council debate completed. Execute the following action plan:\n\n` +
    `${taskDescription}\n\n` +
    (plan.prerequisites.length > 0 ? `Prerequisites: ${plan.prerequisites.join(", ")}\n\n` : "") +
    `Proceed step by step. Commit after each major change.`;

  yield* processMessage(executionPrompt);
}
