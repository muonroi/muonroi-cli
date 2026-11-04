import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { logger } from "../utils/logger.js";
import type { EERecallEntry, EERecallResponse } from "./types.js";

const PREFIX = "EE context: ";
export const isConcreteEEProject = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value) &&
  !["all", "any"].includes(value.toLowerCase());
export function resolveEECwd(value: string): string {
  const expanded =
    value === "~" ? os.homedir() : /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded) || expanded.length > 1024)
    throw new Error("cwd must be an absolute repository path (or ~/path), at most 1024 characters");
  return path.resolve(expanded);
}
interface Scope {
  cwd: string;
  project?: string;
}
interface Receipt extends Scope {
  kind: "ee-context/v1";
  owner: string;
  anchor: string;
  handles?: { id: string; collection: string }[];
}
interface Request extends Scope {
  ticket: number;
  source: "cwd" | "explicit" | "task";
}

/** Task-owned recall scope; not workflow, filesystem or permission authority. */
export class NativeEEContext {
  private anchor: string;
  private binding?: Scope;
  private ticket = 0;
  private origins = new Map<string, Scope & { ticket: number }>();
  lastRecall: { state: string; checkedAt?: string; project?: string; cwd?: string; count?: number } = {
    state: "not_checked",
  };

  constructor(
    private owner: string,
    cwd: string,
    messages: readonly ModelMessage[] = [],
    continuing = false,
    canContinue: (text: string) => boolean = () => false,
  ) {
    this.anchor = path.resolve(cwd);
    if (!continuing) return;
    let restored = false;
    for (const message of [...messages].reverse()) {
      if (message.role === "user") {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content.map((p) => (p.type === "text" ? p.text : "[attachment]")).join("\n");
        if (!canContinue(text)) break;
      }
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of [...message.content].reverse()) {
        if (part.type !== "tool-result" || part.toolName !== "ee_query" || part.output.type !== "text") continue;
        const receipt = readEEContextReceipt(part.output.value);
        if (!receipt || receipt.owner !== owner || receipt.anchor !== this.anchor) continue;
        if (!restored) {
          this.binding = receipt.project ? { project: receipt.project, cwd: receipt.cwd } : undefined;
          restored = true;
        }
        if (receipt.project)
          for (const handle of receipt.handles ?? []) {
            const key = `${handle.collection}:${handle.id}`;
            if (!this.origins.has(key))
              this.origins.set(key, { project: receipt.project, cwd: receipt.cwd, ticket: 0 });
          }
      }
    }
  }

  alignCwd(cwd: string): void {
    if (path.resolve(cwd) !== this.anchor) {
      this.anchor = path.resolve(cwd);
      this.reset();
    }
  }
  reset(): void {
    this.binding = undefined;
    this.ticket++;
    this.lastRecall = { state: "not_checked" };
  }
  scope(): Scope & { source: "task" | "cwd" } {
    return { ...(this.binding ?? { cwd: this.anchor }), source: this.binding ? "task" : "cwd" };
  }
  request(input: { cwd?: unknown; project?: unknown }): Request {
    if (input.project !== undefined && !isConcreteEEProject(input.project))
      throw new Error("project must be a concrete EE slug; use action=projects to discover it");
    if (input.cwd !== undefined && typeof input.cwd !== "string")
      throw new Error("cwd must be an absolute repository path");
    const explicit = input.cwd !== undefined || input.project !== undefined;
    const scope = explicit
      ? {
          cwd:
            input.cwd !== undefined
              ? resolveEECwd(input.cwd as string)
              : this.binding && this.binding.project === input.project
                ? this.binding.cwd
                : this.anchor,
          ...(input.project !== undefined ? { project: input.project as string } : {}),
        }
      : this.scope();
    return { ...scope, source: explicit ? "explicit" : this.binding ? "task" : "cwd", ticket: ++this.ticket };
  }
  complete(request: Request, result: EERecallResponse | null, entries: EERecallEntry[]): string {
    // The shared recall adapter has already rejected missing/mismatched strict proof.
    const verified = result?.scope?.strict === true && isConcreteEEProject(result.scope.project);
    if (verified)
      for (const entry of entries) {
        const key = `${entry.collection}:${entry.id}`;
        if ((this.origins.get(key)?.ticket ?? -1) < request.ticket)
          this.origins.set(key, { project: result.scope!.project, cwd: request.cwd, ticket: request.ticket });
      }
    if (request.ticket !== this.ticket) return ""; // A late completion cannot replace a newer scope/reset.
    const text = result?.text ?? "";
    const state = !result
      ? "unavailable"
      : text.startsWith("[ee_scope_unverified]")
        ? "scope_unverified"
        : text.startsWith("[ee_project_required]")
          ? "project_required"
          : text.startsWith("[ee_request_rejected]")
            ? "rejected"
            : "ok";
    this.lastRecall = {
      state,
      checkedAt: new Date().toISOString(),
      cwd: request.cwd,
      project: result?.scope?.project ?? request.project,
      ...(state === "ok" ? { count: result?.count ?? 0 } : {}),
    };
    if (!verified) return "";
    this.binding = { cwd: request.cwd, project: result.scope!.project };
    return this.receipt(entries);
  }
  receipt(entries: EERecallEntry[] = []): string {
    const value: Receipt = {
      kind: "ee-context/v1",
      owner: this.owner,
      anchor: this.anchor,
      ...(this.binding ?? { cwd: this.anchor }),
    };
    const handles = entries
      .flatMap((e) => (typeof e.collection === "string" ? [{ id: String(e.id), collection: e.collection }] : []))
      .slice(0, 20);
    while (handles.length && PREFIX.length + JSON.stringify({ ...value, handles }).length > 3000) handles.pop();
    if (handles.length) value.handles = handles;
    return PREFIX + JSON.stringify(value);
  }
  feedbackScope(id: string, collection: string): Scope {
    const matches = [...this.origins].filter(([key]) => key.startsWith(`${collection}:${id}`));
    if (matches.length > 1) throw new Error("Ambiguous recalled id prefix; use the full entry id");
    const scope = matches[0]?.[1] ?? this.scope();
    return { cwd: scope.cwd, project: scope.project };
  }
  describe(): string {
    return `EE native scope ${JSON.stringify(this.scope())}. Recall needs only query; use cwd or project once for another repository, action=projects to discover slugs, action=scope to inspect, action=reset to return to shell scope.`;
  }
}

/** Only a native ee_query result header is a resumable scope receipt. */
export function readEEContextReceipt(output: string): Receipt | undefined {
  if (!output.startsWith(PREFIX)) return;
  const line = output.split("\n", 1)[0]!;
  if (line.length > 3000) return;
  try {
    const value = JSON.parse(line.slice(PREFIX.length));
    if (
      value.kind !== "ee-context/v1" ||
      typeof value.owner !== "string" ||
      typeof value.anchor !== "string" ||
      typeof value.cwd !== "string" ||
      (value.project !== undefined && !isConcreteEEProject(value.project)) ||
      resolveEECwd(value.cwd) !== value.cwd ||
      resolveEECwd(value.anchor) !== value.anchor
    )
      return;
    const handles = Array.isArray(value.handles)
      ? value.handles
          .slice(0, 20)
          .filter(
            (h: any) =>
              h &&
              typeof h.id === "string" &&
              /^[\w-]{1,200}$/.test(h.id) &&
              typeof h.collection === "string" &&
              /^[\w-]{1,200}$/.test(h.collection),
          )
      : [];
    return {
      kind: value.kind,
      owner: value.owner,
      anchor: value.anchor,
      cwd: value.cwd,
      ...(value.project ? { project: value.project } : {}),
      handles,
    };
  } catch (error) {
    logger.file("warn", "ee", "Invalid native EE context receipt ignored", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function displayedRecallEntries(entries: EERecallEntry[] | undefined, text: string): EERecallEntry[] {
  const handles = [...text.matchAll(/\[(?:id:)?([\w-]+)\s+(?:col:)?([\w-]+)\]/g)];
  return (entries ?? []).filter((e) => handles.some((h) => String(e.id).startsWith(h[1]!) && e.collection === h[2]));
}
