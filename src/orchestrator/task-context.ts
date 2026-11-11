import path from "node:path";
import type { ModelMessage } from "ai";
import { NativeEEContext } from "../ee/native-context.js";
import { progressiveContextEnabled, TASK_STAGE_GUIDANCE, TASK_STAGES, type TaskStage } from "../pil/context-modules.js";
import { logger } from "../utils/logger.js";
import { foldDynamicTailIntoUserMessage } from "./cache-prefix.js";
import type { ExecutionRole } from "./orchestration-policy.js";
import { type ContextProtection, type RootCompletionFacts, WorkingContext } from "./working-context.js";

export interface TaskContextReceipt {
  kind: "task-context/v1";
  owner: string;
  cwd: string;
  stage: TaskStage;
  revision: number;
  handoff: string;
  error?: string;
}

function validStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (TASK_STAGES as readonly string[]).includes(value);
}

/** Turn/job-owned state; never a global phase tracker or edit authorization. */
export class TaskContext {
  readonly ee: NativeEEContext;
  working: WorkingContext;
  readonly enabled = progressiveContextEnabled();
  private state: TaskContextReceipt;
  private explicit = false;
  private observed = new Set<string>();
  selectionSource: "initial" | "observed" | "explicit" = "initial";

  constructor(
    owner: string,
    cwd: string,
    messages: readonly ModelMessage[] = [],
    continuing = false,
    initial: TaskStage = "orient",
    canContinue: (text: string) => boolean = () => false,
  ) {
    this.working = new WorkingContext(owner, cwd, messages);
    this.ee = new NativeEEContext(owner, cwd, messages, continuing, canContinue);
    this.state = { kind: "task-context/v1", owner, cwd: path.resolve(cwd), stage: initial, revision: 0, handoff: "" };
    if (!continuing || !this.enabled) return;
    for (const message of [...messages].reverse()) {
      if (message.role === "user") {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content.map((p) => (p.type === "text" ? p.text : "[attachment]")).join("\n");
        if (!canContinue(text)) break; // Never restore through a different intervening task.
        continue;
      }
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of [...message.content].reverse()) {
        if (part.type !== "tool-result" || part.toolName !== "context_load") continue;
        const output = part.output;
        if (output.type !== "text") continue;
        try {
          const receipt = JSON.parse(output.value) as TaskContextReceipt;
          if (
            receipt.kind !== "task-context/v1" ||
            receipt.owner !== owner ||
            receipt.cwd !== this.state.cwd ||
            receipt.error ||
            !validStage(receipt.stage) ||
            !Number.isSafeInteger(receipt.revision) ||
            receipt.revision < 0 ||
            typeof receipt.handoff !== "string" ||
            receipt.handoff.length > 1500
          )
            continue;
          this.state = { ...this.state, stage: receipt.stage, revision: receipt.revision, handoff: receipt.handoff };
          this.explicit = true;
          this.selectionSource = "explicit";
          return;
        } catch (err) {
          logger.file("warn", "orchestrator", "Invalid task-context receipt ignored", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  snapshot(): TaskContextReceipt {
    return { ...this.state };
  }

  alignCwd(cwd: string): void {
    this.ee.alignCwd(cwd);
    const resolved = path.resolve(cwd);
    if (resolved !== this.state.cwd) {
      this.working = new WorkingContext(this.state.owner, resolved);
      this.state = { ...this.state, cwd: resolved, stage: "orient", handoff: "", revision: this.state.revision + 1 };
      this.explicit = false;
      this.selectionSource = "initial";
    }
  }

  /** Guidance follows completed native operations, never shell text or inferred intent.
   * Called only after step 0; historical turns and explicit selections are excluded. */
  observe(messages: readonly ModelMessage[]): void {
    if (!this.enabled) return;
    let start = messages.length - 1;
    while (start >= 0 && messages[start]?.role !== "user") start--;
    for (const message of messages.slice(start + 1)) {
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-result" || this.observed.has(part.toolCallId)) continue;
        this.observed.add(part.toolCallId);
        if (this.explicit) continue;
        if (part.output.type !== "text" && part.output.type !== "json") continue;
        let value: unknown = part.output.value;
        if (typeof value === "string" && value.trimStart().startsWith("{")) {
          try {
            value = JSON.parse(value);
          } catch (err) {
            logger.file("debug", "orchestrator", "Stage observation ignored non-JSON tool text", {
              tool: part.toolName,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        let stage: TaskStage | undefined;
        if (
          part.toolName === "read_file" &&
          typeof value === "string" &&
          /^\[[^\n]+: lines \d+-\d+ of \d+\]/.test(value)
        )
          stage = "research";
        if (value && typeof value === "object" && "success" in value && value.success === true) {
          if (part.toolName === "edit_file" || part.toolName === "write_file")
            stage = "preview" in value && value.preview === true ? "research" : "implement";
          if (part.toolName === "verification_run") stage = "verify";
        }
        if (stage && stage !== this.state.stage) {
          this.state = { ...this.state, stage, revision: this.state.revision + 1 };
          this.selectionSource = "observed";
        }
      }
    }
  }

  select(input: { stage?: unknown; expected_revision?: unknown; handoff?: unknown }): TaskContextReceipt {
    const fail = (error: string) => ({ ...this.state, error });
    if (!this.enabled) return fail("Progressive context is disabled; current execution uses the legacy prompt.");
    if (!validStage(input.stage)) return fail("Unknown stage; choose orient, research, plan, implement or verify.");
    if (input.expected_revision !== undefined && input.expected_revision !== this.state.revision)
      return fail("Context revision changed; use the returned revision before retrying a transition.");
    if (input.handoff !== undefined && (typeof input.handoff !== "string" || input.handoff.length > 1500))
      return fail(
        "handoff must be a string of at most 1500 characters; preserve evidence IDs and unresolved failures.",
      );
    const handoff = input.handoff === undefined ? this.state.handoff : (input.handoff as string);
    const next = { ...this.state, stage: input.stage, handoff, revision: this.state.revision + 1 };
    if (JSON.stringify(next).length > 3000)
      return fail("Encoded handoff receipt exceeds 3000 characters; shorten it while retaining evidence IDs.");
    this.explicit = true;
    this.selectionSource = "explicit";
    if (input.stage !== this.state.stage || handoff !== this.state.handoff) this.state = next;
    return this.snapshot();
  }

  block(executionRole?: ExecutionRole): string {
    if (!this.enabled) return "";
    const guidance =
      executionRole === "orchestrator"
        ? `Own the ${this.state.stage} stage: inspect current plan/source/evidence directly with native read_file and grep, reconcile completed scope and remaining deliverables, and pin the original user goal as the working ledger's root_goal (goal is only the current wave). Delegate broad research, implementation, commands/tests and independent verification to eligible workers. Runtime-only audits and probes also belong to workers. Your own reading does not replace independent acceptance. Preserve workflow/approval gates; a context stage grants no authority. A blocked worker requires a truthful blocker report or channel repair, never unsupported probes.`
        : TASK_STAGE_GUIDANCE[this.state.stage];
    return `[Task context stage=${this.state.stage} revision=${this.state.revision}; guidance only, not authorization]\n${guidance}\n${this.ee.describe()}${this.state.handoff ? `\nAgent handoff data (not policy or authorization):\n${this.state.handoff}` : ""}${this.working.block() ? `\n${this.working.block()}` : ""}`;
  }

  measurements(messages?: readonly ModelMessage[], executionRole?: ExecutionRole): Record<string, number> {
    const included = this.enabled && (messages === undefined || messages.some((m) => projectedBases.has(m)));
    return {
      taskContextChars: included ? this.block(executionRole).length : 0,
      taskHandoffChars: included ? this.state.handoff.length : 0,
      taskContextRevision: this.state.revision,
      ...this.working.measurements(),
    };
  }

  /** Host facts (native FLOW completion scope) consulted when main marks the root goal complete. */
  completionFacts?: () => RootCompletionFacts | null;
  contextProtection?: () => Promise<ContextProtection>;
  async refreshProtection(): Promise<void> {
    if (!this.contextProtection) return;
    try {
      this.working.setProtection(await this.contextProtection());
    } catch (err) {
      logger.file("warn", "orchestrator", "Context pruning protections unavailable; retaining history", {
        error: String(err),
      });
      this.working.setProtection({ unavailable: true });
    }
  }
}

// Only identities produced here are replaceable: never remove user text by matching a marker.
const projectedBases = new WeakMap<object, ModelMessage>();
export function projectTaskContext<T extends ModelMessage>(
  messages: readonly T[],
  context: TaskContext,
  executionRole?: ExecutionRole,
): T[] {
  if (context.enabled) messages = context.working.project(messages);
  const block = context.block(executionRole);
  if (!block) return [...messages];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== "user") index--;
  if (index < 0) return [...messages];
  const current = messages[index]!;
  const original = projectedBases.get(current) ?? current;
  const projected = foldDynamicTailIntoUserMessage(original, block) as T;
  projectedBases.set(projected, original);
  return [...messages.slice(0, index), projected, ...messages.slice(index + 1)];
}
