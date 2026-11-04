import { readFileSync } from "node:fs";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { ExecutionRole } from "../orchestrator/orchestration-policy.js";
import type { TaskContext } from "../orchestrator/task-context.js";
import { TASK_STAGES } from "../pil/context-modules.js";
import { nativeCapabilitiesReference } from "../pil/native-capabilities-workbook.js";
import { discoverSkills } from "../utils/skills.js";

export function registerContextLoader(
  tools: ToolSet,
  context: TaskContext,
  cwd: () => string,
  executionRole?: ExecutionRole,
): void {
  if (!context.enabled) return;
  tools.context_load = dynamicTool({
    description:
      "Select task-stage guidance or a task-aware working_set without granting permission. working_set inspect returns stable closed-turn IDs and protections; update replaces the current task ledger and archives explicitly irrelevant completed turns from future requests only. Keep constraints, unresolved failures, negative evidence and dependency tool/turn IDs. reset restores available history. Use at task/stage boundaries or after noisy work, not every step. Also search/page skills and the CLI reference.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        topic: { type: "string", enum: ["stage", "working_set", "skills", "reference"] },
        action: { type: "string", enum: ["inspect", "update", "reset"] },
        task_id: { type: "string", maxLength: 120 },
        goal: { type: "string", maxLength: 1000 },
        constraints: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        decisions: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        open_items: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        keep_tool_ids: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        keep_turn_ids: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        archive: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            properties: { turn_id: { type: "string" }, reason: { type: "string", minLength: 1, maxLength: 160 } },
            required: ["turn_id", "reason"],
            additionalProperties: false,
          },
        },
        archive_through: {
          type: ["object", "null"],
          properties: { turn_id: { type: "string" }, reason: { type: "string", minLength: 1, maxLength: 160 } },
          required: ["turn_id", "reason"],
          additionalProperties: false,
          description:
            "Retire closed turns through this inspected boundary, preserving host protections and explicit kept dependencies. A bounded alternative to accumulating archive IDs. null disables the boundary; keep_turn_ids restores selected earlier turns.",
        },
        restore_turn_ids: { type: "array", maxItems: 32, items: { type: "string" } },
        replace_checkpoint: {
          type: "boolean",
          description:
            "Explicitly replace an old narrative checkpoint with this complete working ledger. Refused while jobs remain unacknowledged. Original history remains on disk.",
        },
        stage: { type: "string", enum: [...TASK_STAGES] },
        expected_revision: { type: "integer", minimum: 0 },
        handoff: {
          type: "string",
          maxLength: 1500,
          description:
            "Decisions, next action, unresolved failures and session/toolCallId evidence references; no raw logs.",
        },
        query: { type: "string", maxLength: 256 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    }),
    execute: async (input: any, execution) => {
      execution.abortSignal?.throwIfAborted();
      context.alignCwd(cwd());
      const topic = input?.topic ?? "stage";
      if (topic === "working_set") {
        await context.refreshProtection();
        const action = input?.action ?? "inspect";
        if (action === "inspect") {
          const offset = input?.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0)
            return JSON.stringify({ error: "offset must be a non-negative integer" });
          return JSON.stringify(context.working.inspect(offset));
        }
        if (action !== "update" && action !== "reset")
          return JSON.stringify({ error: "working_set action must be inspect, update or reset" });
        return JSON.stringify(context.working.update(input));
      }
      if (topic === "stage") return JSON.stringify(context.select(input ?? {}));
      const offset = input?.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        return JSON.stringify({ error: "offset must be a non-negative integer" });
      if (topic === "reference") {
        const reference = nativeCapabilitiesReference(executionRole);
        return JSON.stringify({
          offset,
          total_chars: reference.length,
          content: reference.slice(offset, offset + 4000),
          next_offset: offset + 4000 < reference.length ? offset + 4000 : null,
          note:
            executionRole === "worker"
              ? "Subsystem descriptions, not worker grants. Dispatch/council/FLOW descriptions belong to main or infrastructure; workers cannot recursively dispatch. Only actual granted tools are callable, and explore/review remain read-only within their assigned scope."
              : "Subsystem descriptions, not a live capability or sandbox inventory. Actual tools, runtime snapshots and required repository policies remain authoritative.",
        });
      }
      if (topic !== "skills") return JSON.stringify({ error: "topic must be stage, working_set, skills or reference" });
      if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 256))
        return JSON.stringify({ error: "query must be a string of at most 256 characters" });
      const query = (input.query ?? "").trim().toLowerCase();
      const skills = discoverSkills(cwd()).filter(
        (s) => !query || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
      );
      const page = skills.slice(offset, offset + 5).map((s) => ({
        name: s.name,
        description: s.description.slice(0, 1024),
        description_chars: s.description.length,
        description_truncated: s.description.length > 1024,
        path: s.skillMdPath,
        scope: s.scope,
        ...(s.scope === "builtin" && query === s.name ? { instructions: readFileSync(s.skillMdPath, "utf8") } : {}),
      }));
      return JSON.stringify({
        total: skills.length,
        offset,
        skills: page,
        next_offset: offset + page.length < skills.length ? offset + page.length : null,
        note: "Read the original SKILL.md at path for complete instructions. Empty query pages the full catalog.",
      });
    },
  });
}
