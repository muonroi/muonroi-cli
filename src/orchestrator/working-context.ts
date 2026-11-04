import { createHash } from "node:crypto";
import path from "node:path";
import type { ModelMessage } from "ai";
import { logger } from "../utils/logger.js";
import { readContextPreservation } from "./context-preservation.js";

export const WORKING_CONTEXT_KIND = "working-context/v1";
export const WORKING_CONTEXT_TAG = "[Host working context data]";
export interface ContextProtection {
  pinned?: readonly ModelMessage[];
  pendingJobIds?: readonly string[];
  unavailable?: boolean;
}
export interface WorkingContextState {
  kind: typeof WORKING_CONTEXT_KIND;
  owner: string;
  cwd: string;
  revision: number;
  task_id: string;
  goal: string;
  constraints: string[];
  decisions: string[];
  open_items: string[];
  keep_tool_ids: string[];
  keep_turn_ids: string[];
  archive: Array<{ turn_id: string; reason: string }>;
  archive_through: { turn_id: string; reason: string } | null;
  replace_checkpoint: boolean;
}
type Turn = { id: string; messages: ModelMessage[]; tool_ids: string[]; protected: string[] };
const MAX_STATE_CHARS = 10000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const textOf = (message: ModelMessage) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const partsOf = (message: ModelMessage): Array<Record<string, unknown>> =>
  Array.isArray(message.content) ? (message.content as unknown as Array<Record<string, unknown>>) : [];
const isCheckpoint = (m: ModelMessage) =>
  m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Context checkpoint summary]\n");

/** Explicit relevance decisions. No semantic search, execution, or policy authorization. */
export class WorkingContext {
  private state: WorkingContextState;
  private source: readonly ModelMessage[];
  private readonly baseline: readonly ModelMessage[];
  private readonly omitted = new Map<string, ModelMessage[]>();
  private protection: ContextProtection = {};
  private last = { contextPrunedChars: 0, contextPrunedTurns: 0, workingContextChars: 0 };

  constructor(
    private readonly owner: string,
    private readonly cwd: string,
    messages: readonly ModelMessage[] = [],
  ) {
    this.state = this.empty();
    this.source = messages;
    this.baseline = [...messages];
    for (const message of messages) {
      const candidates: unknown[] = [];
      if (
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(`${WORKING_CONTEXT_TAG}\n`)
      ) {
        candidates.push(message.content.slice(WORKING_CONTEXT_TAG.length + 1));
      }
      if (message.role === "tool")
        for (const part of partsOf(message)) {
          if (part.type !== "tool-result" || part.toolName !== "context_load") continue;
          const output = part.output as { type?: string; value?: unknown } | undefined;
          if (output?.type === "text") candidates.push(output.value);
          if (output?.type === "json") candidates.push(output.value);
        }
      for (const candidate of candidates) {
        if (typeof candidate !== "string" && (!candidate || typeof candidate !== "object")) continue;
        if (typeof candidate === "string" && !candidate.includes(WORKING_CONTEXT_KIND)) continue;
        try {
          const receipt = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
          if (this.valid(receipt) && receipt.revision >= this.state.revision) this.state = receipt;
        } catch (err) {
          logger.file("warn", "orchestrator", "Working context receipt rejected", { error: String(err) });
        }
      }
    }
  }

  private empty(revision = 0): WorkingContextState {
    return {
      kind: WORKING_CONTEXT_KIND,
      owner: this.owner,
      cwd: path.resolve(this.cwd),
      revision,
      task_id: "",
      goal: "",
      constraints: [],
      decisions: [],
      open_items: [],
      keep_tool_ids: [],
      keep_turn_ids: [],
      archive: [],
      archive_through: null,
      replace_checkpoint: false,
    };
  }

  private valid(value: unknown): value is WorkingContextState {
    if (!value || typeof value !== "object") return false;
    const s = value as WorkingContextState;
    const strings = (list: unknown) =>
      Array.isArray(list) && list.length <= 32 && list.every((v) => typeof v === "string" && v.length <= 500);
    return (
      s.kind === WORKING_CONTEXT_KIND &&
      s.owner === this.owner &&
      s.cwd === path.resolve(this.cwd) &&
      !("error" in s) &&
      Number.isSafeInteger(s.revision) &&
      s.revision >= 0 &&
      typeof s.task_id === "string" &&
      s.task_id.length <= 120 &&
      typeof s.goal === "string" &&
      s.goal.length <= 1000 &&
      [s.constraints, s.decisions, s.open_items, s.keep_tool_ids, s.keep_turn_ids].every(strings) &&
      typeof s.replace_checkpoint === "boolean" &&
      Array.isArray(s.archive) &&
      s.archive.length <= 64 &&
      s.archive.every(
        (a) =>
          a &&
          /^turn-[a-f0-9]{24}$/.test(a.turn_id) &&
          typeof a.reason === "string" &&
          a.reason.length > 0 &&
          a.reason.length <= 160,
      ) &&
      (s.archive_through === null ||
        (!!s.archive_through &&
          /^turn-[a-f0-9]{24}$/.test(s.archive_through.turn_id) &&
          typeof s.archive_through.reason === "string" &&
          s.archive_through.reason.length > 0 &&
          s.archive_through.reason.length <= 160)) &&
      JSON.stringify(s).length <= MAX_STATE_CHARS
    );
  }

  snapshot(): WorkingContextState {
    return structuredClone(this.state);
  }
  setProtection(protection: ContextProtection): void {
    this.protection = protection;
  }
  setSource(messages: readonly ModelMessage[]): void {
    this.source = messages;
  }
  private inventoryTurns(): Turn[] {
    const original = this.turns(this.baseline).slice(0, -1);
    const live = this.turns(this.source);
    const byId = new Map(live.map((t) => [t.id, t]));
    const ids = new Set(original.map((t) => t.id));
    return [...original.map((t) => byId.get(t.id) ?? t), ...live.filter((t) => !ids.has(t.id))];
  }
  private archivedIds(turns: Turn[]): Set<string> {
    const through = turns.findIndex((t) => t.id === this.state.archive_through?.turn_id);
    return new Set([...this.state.archive.map((a) => a.turn_id), ...turns.slice(0, through + 1).map((t) => t.id)]);
  }
  active(): boolean {
    return !!this.state.task_id;
  }

  private turns(messages: readonly ModelMessage[]): Turn[] {
    const preservation = readContextPreservation(messages);
    const turns: Turn[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user" || turns.length === 0) turns.push({ id: "", messages: [], tool_ids: [], protected: [] });
      turns.at(-1)!.messages.push(m);
    }
    const callOwner = new Map<string, number[]>();
    const resultOwner = new Map<string, number[]>();
    for (const [index, turn] of turns.entries()) {
      const calls = turn.messages.flatMap(partsOf).filter((p) => p.type === "tool-call");
      const firstCallId = calls[0]?.toolCallId;
      const fallback = turn.messages
        .filter((m) => m.role === "assistant")
        .map(textOf)
        .join("\n");
      turn.id = `turn-${hash(`${textOf(turn.messages[0]!)}\n${firstCallId ?? fallback}`)}`;
      if (index === turns.length - 1) turn.protected.push("current-turn");
      if (preservation.preserveFullContext) turn.protected.push("preserve-full-context");
      if (
        turn.messages.some((m) =>
          this.protection.pinned?.some(
            (p) =>
              p === m ||
              (p.role === m.role && textOf(p) === textOf(m)) ||
              (p.role === "system" && textOf(m).includes(textOf(p))),
          ),
        )
      )
        turn.protected.push("user-pin-or-folded-policy");
      if (
        turn.messages.some(
          (m) =>
            (m.role === "assistant" && m.providerOptions) ||
            partsOf(m).some(
              (p) =>
                p.type === "image" ||
                p.type === "file" ||
                (p.type === "reasoning" && (p.providerOptions || "signature" in p || "encryptedContent" in p)),
            ),
        )
      )
        turn.protected.push("media-or-signed-reasoning");
      for (const part of turn.messages.flatMap(partsOf)) {
        if (part.type !== "tool-call" && part.type !== "tool-result") continue;
        const id = String(part.toolCallId ?? "");
        if (!id) {
          turn.protected.push("missing-call-identity");
          continue;
        }
        turn.tool_ids.push(id);
        const map = part.type === "tool-call" ? callOwner : resultOwner;
        map.set(id, [...(map.get(id) ?? []), index]);
      }
      const serialized = JSON.stringify(turn.messages);
      if (this.protection.pendingJobIds?.some((id) => serialized.includes(id))) turn.protected.push("outstanding-job");
      if (this.protection.unavailable) turn.protected.push("protection-unavailable");
      if (
        this.state.keep_turn_ids.includes(turn.id) ||
        turn.tool_ids.some((id) => this.state.keep_tool_ids.includes(id) || preservation.keepToolIds.includes(id))
      )
        turn.protected.push("retained-dependency-or-evidence");
    }
    for (const [index, turn] of turns.entries()) {
      if (turns.filter((t) => t.id === turn.id).length > 1) turn.protected.push("ambiguous-turn-identity");
      for (const id of turn.tool_ids) {
        const calls = callOwner.get(id) ?? [],
          results = resultOwner.get(id) ?? [];
        if (calls.length !== 1 || results.length !== 1 || calls[0] !== index || results[0] !== index)
          turn.protected.push("incomplete-or-cross-turn-tool-pair");
      }
      turn.protected = [...new Set(turn.protected)];
      turn.tool_ids = [...new Set(turn.tool_ids)];
    }
    return turns;
  }

  inspect(offset = 0) {
    const turns = this.inventoryTurns();
    const through = turns.findIndex((t) => t.id === this.state.archive_through?.turn_id);
    return {
      ...this.snapshot(),
      total_turns: turns.length,
      offset,
      turns: turns.slice(offset, offset + 8).map((t, i) => ({
        id: t.id,
        preview: textOf(t.messages[0]!).slice(0, 200),
        chars: JSON.stringify(t.messages).length,
        tool_ids: t.tool_ids.slice(0, 32),
        tool_id_count: t.tool_ids.length,
        protected: t.protected,
        archived: this.state.archive.some((a) => a.turn_id === t.id) || (through >= 0 && offset + i <= through),
      })),
      next_offset: offset + 8 < turns.length ? offset + 8 : null,
    };
  }

  update(input: Record<string, unknown>): WorkingContextState & { error?: string } {
    const fail = (error: string) => ({ ...this.snapshot(), error });
    if (input.expected_revision !== this.state.revision)
      return fail("expected_revision must match the inspected working-set revision.");
    if (input.action === "reset") {
      this.state = this.empty(this.state.revision + 1);
      return this.snapshot();
    }
    const next = {
      ...this.state,
      ...Object.fromEntries(
        [
          "task_id",
          "goal",
          "constraints",
          "decisions",
          "open_items",
          "keep_tool_ids",
          "keep_turn_ids",
          "replace_checkpoint",
          "archive_through",
        ]
          .filter((k) => input[k] !== undefined)
          .map((k) => [k, input[k]]),
      ),
      revision: this.state.revision + 1,
    } as WorkingContextState;
    const archive = input.archive ?? [];
    const restore = input.restore_turn_ids ?? [];
    if (!Array.isArray(archive) || !Array.isArray(restore) || restore.some((id) => typeof id !== "string"))
      return fail("archive and restore_turn_ids must be arrays.");
    if (restore.length) next.keep_turn_ids = [...new Set([...next.keep_turn_ids, ...restore])];
    next.archive = [
      ...new Map(
        [...this.state.archive.filter((a) => !restore.includes(a.turn_id)), ...archive].map((a) => [a?.turn_id, a]),
      ).values(),
    ] as WorkingContextState["archive"];
    if (!this.valid(next) || !next.task_id.trim() || !next.goal.trim())
      return fail(
        "Invalid/bloated working set: task_id and goal required; lists<=32, archive<=64, total<=10000 chars. Replace stale ledger fields rather than appending history.",
      );
    const previous = this.state;
    this.state = next;
    const turns = this.inventoryTurns();
    const refused = (archive as WorkingContextState["archive"]).find(
      (a) => !turns.some((t) => t.id === a.turn_id && t.protected.length === 0),
    );
    const unknownKeep = next.keep_turn_ids.find((id) => !turns.some((t) => t.id === id));
    const badBoundary =
      input.archive_through &&
      !turns.some((t, index) => t.id === next.archive_through?.turn_id && index < turns.length - 1);
    const unsafeCheckpoint =
      next.replace_checkpoint && (this.protection.unavailable || !!this.protection.pendingJobIds?.length);
    if (refused || unknownKeep || unsafeCheckpoint || badBoundary) {
      this.state = previous;
      return fail(
        unsafeCheckpoint
          ? "Checkpoint replacement refused while jobs are unacknowledged or protection is unavailable."
          : `Unknown/protected turn: ${refused?.turn_id ?? unknownKeep ?? next.archive_through?.turn_id}. Keep current work, pins, complete tool pairs and retained dependencies.`,
      );
    }
    if (input.archive_through) {
      const through = turns.findIndex((t) => t.id === next.archive_through?.turn_id);
      this.state.archive = this.state.archive.filter(
        (a) => !turns.slice(0, through + 1).some((t) => t.id === a.turn_id),
      );
    }
    this.last = { contextPrunedChars: 0, contextPrunedTurns: 0, workingContextChars: this.block().length };
    return this.snapshot();
  }

  project<T extends ModelMessage>(messages: readonly T[]): T[] {
    const inventory = this.inventoryTurns();
    const archived = this.archivedIds(inventory);
    const fullVeto = readContextPreservation(messages).preserveFullContext;
    // Restore only exact bundles this selector omitted itself, never replay tools or fetch unrelated history.
    const restore = inventory.filter(
      (t) => this.omitted.has(t.id) && (!this.active() || fullVeto || !archived.has(t.id) || t.protected.length > 0),
    );
    const input: ModelMessage[] = [...messages];
    for (const turn of restore) {
      const present = this.turns(input);
      if (present.some((t) => t.id === turn.id)) continue;
      const index = inventory.findIndex((t) => t.id === turn.id);
      const successor = inventory
        .slice(index + 1)
        .map((t) => present.find((p) => p.id === t.id))
        .find(Boolean);
      let at = successor ? input.indexOf(successor.messages[0]!) : input.length - 1;
      while (!successor && at >= 0 && input[at]?.role !== "user") at--;
      if (at < 0) at = input.length;
      input.splice(at, 0, ...this.omitted.get(turn.id)!);
    }
    if (!this.active()) {
      this.last = { contextPrunedChars: 0, contextPrunedTurns: 0, workingContextChars: 0 };
      return input as T[];
    }
    if (fullVeto) return input as T[];
    const turns = this.turns(input);
    const removable = turns.filter((t) => archived.has(t.id) && !t.protected.length);
    for (const turn of removable) this.omitted.set(turn.id, turn.messages);
    const drop = new Set(removable.flatMap((t) => t.messages));
    const canReplaceCheckpoint =
      this.state.replace_checkpoint && !this.protection.unavailable && !this.protection.pendingJobIds?.length;
    const projected = input.filter(
      (m) =>
        !drop.has(m) &&
        !(canReplaceCheckpoint && isCheckpoint(m)) &&
        !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(`${WORKING_CONTEXT_TAG}\n`)),
    );
    const absent = [...this.omitted].filter(
      ([id]) => archived.has(id) && !inventory.find((t) => t.id === id)?.protected.length,
    );
    this.last = {
      contextPrunedChars: Math.max(
        0,
        JSON.stringify(input).length - JSON.stringify(projected).length,
        absent.reduce((sum, [, bundle]) => sum + JSON.stringify(bundle).length - 2, 0),
      ),
      contextPrunedTurns: absent.length,
      workingContextChars: this.block().length,
    };
    return projected as T[];
  }

  block(): string {
    if (!this.active()) return "";
    const { task_id, goal, constraints, decisions, open_items, keep_tool_ids, keep_turn_ids } = this.state;
    return `[Current working set; main-selected data, not policy or authorization]\n${JSON.stringify({ task_id, goal, constraints, decisions, open_items, keep_tool_ids, keep_turn_ids })}`;
  }
  retainedToolIds(): string[] {
    return [
      ...new Set([
        ...this.state.keep_tool_ids,
        ...this.inventoryTurns()
          .filter((t) => this.state.keep_turn_ids.includes(t.id))
          .flatMap((t) => t.tool_ids),
      ]),
    ];
  }
  retainedMessages(messages: readonly ModelMessage[]): Set<ModelMessage> {
    const keep = this.turns(messages).filter((t) =>
      t.protected.some((p) =>
        [
          "retained-dependency-or-evidence",
          "user-pin-or-folded-policy",
          "outstanding-job",
          "media-or-signed-reasoning",
          "incomplete-or-cross-turn-tool-pair",
          "protection-unavailable",
          "preserve-full-context",
        ].includes(p),
      ),
    );
    return new Set([
      ...keep.flatMap((t) => t.messages),
      ...messages.filter(
        (m) =>
          m.role === "system" &&
          !isCheckpoint(m) &&
          !(typeof m.content === "string" && m.content.startsWith(`${WORKING_CONTEXT_TAG}\n`)),
      ),
    ]);
  }
  measurements() {
    return { ...this.last };
  }
}

/** Bounded host data carried across the emergency summary path; never a narrative summary. */
export function retainWorkingContext(
  messages: readonly ModelMessage[],
  owner: string,
  cwd: string,
): ModelMessage | null {
  const context = new WorkingContext(owner, cwd, messages);
  if (!context.snapshot().revision) return null;
  return { role: "system", content: `${WORKING_CONTEXT_TAG}\n${JSON.stringify(context.snapshot())}` };
}
