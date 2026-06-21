import type {
  ProcessMessageObserver,
  ProcessMessageStepFinish,
  ProcessMessageStepStart,
} from "../orchestrator/agent-options";
import type { StreamChunk, StructuredResponse, ToolCall, ToolResult } from "../types";

export type HeadlessOutputFormat = "text" | "json";

export interface HeadlessWrites {
  stdout?: string;
  stderr?: string;
}

/** Semantic JSONL events for headless `--format json` (OpenCode-style). */
export type HeadlessJsonEvent =
  | {
      type: "step_start";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
    }
  | {
      type: "text";
      sessionID?: string;
      stepNumber: number;
      text: string;
      timestamp: number;
    }
  | {
      type: "tool_use";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      toolCall: ToolCall;
      toolResult: ToolResult;
      /** Present when `onToolStart` / `onToolFinish` observer hooks ran for this tool call. */
      timing?: {
        startedAt?: number;
        finishedAt?: number;
        durationMs?: number;
      };
    }
  | {
      type: "step_finish";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      finishReason: string;
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        costUsdTicks?: number;
      };
    }
  | {
      type: "structured_response";
      sessionID?: string;
      stepNumber: number;
      timestamp: number;
      taskType: string;
      data: Record<string, unknown>;
    }
  | {
      type: "error";
      sessionID?: string;
      message: string;
      timestamp: number;
    };

export function isHeadlessOutputFormat(value: string): value is HeadlessOutputFormat {
  return value === "text" || value === "json";
}

export function renderHeadlessPrelude(format: HeadlessOutputFormat, sessionId?: string): HeadlessWrites {
  if (format === "json") {
    return {};
  }

  // Status indicator + session id are progress UX, not the reply. Keep stdout
  // pure (only the model's answer) so `--format text` pipes cleanly. VERIFY F3.
  const statusLines = ["\x1b[36m⏳ Processing...\x1b[0m"];
  if (sessionId) statusLines.push(`\x1b[2mSession: ${sessionId}\x1b[0m`);
  return { stderr: `${statusLines.join("\n")}\n` };
}

/**
 * Headless text output only. JSON streaming uses {@link createHeadlessJsonlEmitter} + `Agent.processMessage` observer.
 */
export function renderHeadlessChunk(chunk: StreamChunk): HeadlessWrites {
  switch (chunk.type) {
    case "content":
      return chunk.content ? { stdout: chunk.content } : {};

    case "tool_calls":
      return chunk.toolCalls?.length
        ? {
            stderr: chunk.toolCalls.map((tc) => `\x1b[33m▸ ${formatToolCallLabel(tc)}\x1b[0m\n`).join(""),
          }
        : {};

    case "tool_result": {
      if (!chunk.toolResult) {
        return {};
      }

      const icon = chunk.toolResult.success ? "▸" : "✗";
      const color = chunk.toolResult.success ? "\x1b[32m" : "\x1b[31m";
      const label = chunk.toolCall ? formatToolCallLabel(chunk.toolCall) : "tool";
      const mediaLines =
        chunk.toolResult.media?.map((asset) => {
          const suffix = asset.url ? ` (${asset.url})` : "";
          return `  ${asset.path}${suffix}`;
        }) ?? [];
      const stderr = [`${color}${icon} ${label}\x1b[0m`, ...mediaLines].join("\n");
      return { stderr: `${stderr}\n` };
    }

    case "structured_response":
      // A respond_* terminal answer arrives ONLY as this chunk (never as
      // `content`). Without this case it hit the no-op default below and the
      // answer was silently dropped from `--format text` stdout.
      return chunk.structuredResponse ? { stdout: `${formatStructuredResponseText(chunk.structuredResponse)}\n` } : {};

    case "error":
      return chunk.content ? { stderr: `\x1b[31m${chunk.content}\x1b[0m\n` } : {};

    case "done":
      return { stdout: "\n" };

    case "reasoning":
      return {};

    default:
      return {};
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Plain-text rendering of a respond_* terminal answer for headless `--format
 * text`. Mirrors the per-taskType layout of {@link StructuredResponseView}
 * (src/ui/components/structured-response-view.tsx) but emits flat text (no ANSI
 * box-drawing) so the answer pipes cleanly. Falls back to the primary text
 * field, then raw JSON, for taskTypes without a dedicated layout.
 */
export function formatStructuredResponseText(sr: StructuredResponse): string {
  const d = (sr.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  switch (sr.taskType) {
    case "general":
      return str(d.response) || JSON.stringify(d, null, 2);

    case "documentation": {
      const examples = arr<{ code?: string; description?: string }>(d.examples);
      const parts = [str(d.content)];
      for (const ex of examples) {
        if (ex.description) parts.push(`\n${ex.description}`);
        if (ex.code) parts.push(ex.code);
      }
      const out = parts.filter(Boolean).join("\n");
      return out || JSON.stringify(d, null, 2);
    }

    case "analyze": {
      const findings = arr<{ text?: string; evidence?: string; severity?: string }>(d.findings);
      if (findings.length === 0) return JSON.stringify(d, null, 2);
      return findings
        .map((f) => {
          const sev = (f.severity ?? "").toUpperCase();
          const head = sev ? `[${sev}] ${f.text ?? ""}` : (f.text ?? "");
          return f.evidence ? `${head}\n  evidence: ${f.evidence}` : head;
        })
        .join("\n");
    }

    case "plan": {
      const steps = arr<{ action?: string; criterion?: string; rationale?: string }>(d.steps);
      const lines: string[] = [];
      steps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.action ?? ""}`);
        if (s.criterion) lines.push(`   done when: ${s.criterion}`);
        if (s.rationale) lines.push(`   why: ${s.rationale}`);
      });
      const assumptions = arr<string>(d.assumptions);
      const risks = arr<string>(d.risks);
      if (assumptions.length > 0) {
        lines.push("", "assumptions:");
        for (const a of assumptions) lines.push(`  - ${a}`);
      }
      if (risks.length > 0) {
        lines.push("", "risks:");
        for (const rk of risks) lines.push(`  - ${rk}`);
      }
      return lines.length > 0 ? lines.join("\n") : JSON.stringify(d, null, 2);
    }

    case "debug": {
      const r = d as {
        hypothesis?: string;
        root_cause?: string;
        fix?: { file?: string; diff?: string };
        verify_command?: string;
      };
      const lines: string[] = [];
      if (r.hypothesis) lines.push(`hypothesis: ${r.hypothesis}`);
      if (r.root_cause) lines.push(`root cause: ${r.root_cause}`);
      if (r.fix?.file) lines.push(`fix: ${r.fix.file}`);
      if (r.fix?.diff) lines.push(r.fix.diff);
      if (r.verify_command) lines.push(`verify: ${r.verify_command}`);
      return lines.length > 0 ? lines.join("\n") : JSON.stringify(d, null, 2);
    }

    case "refactor": {
      const r = d as { summary?: string; changes?: Array<{ file?: string; diff?: string }>; verify_command?: string };
      const lines: string[] = [];
      if (r.summary) lines.push(r.summary);
      for (const c of r.changes ?? []) {
        if (c.file) lines.push(`\n── ${c.file} ──`);
        if (c.diff) lines.push(c.diff);
      }
      if (r.verify_command) lines.push(`verify: ${r.verify_command}`);
      return lines.length > 0 ? lines.join("\n") : JSON.stringify(d, null, 2);
    }

    case "generate": {
      const r = d as { files?: Array<{ path?: string; content?: string; language?: string }>; explanation?: string };
      const lines: string[] = [];
      if (r.explanation) lines.push(r.explanation);
      for (const f of r.files ?? []) {
        const lang = f.language ? ` (${f.language})` : "";
        if (f.path) lines.push(`\n── ${f.path}${lang} ──`);
        if (f.content) lines.push(f.content);
      }
      return lines.length > 0 ? lines.join("\n") : JSON.stringify(d, null, 2);
    }

    default: {
      // Renderer-missing taskType: probe common text-bearing fields, then JSON.
      const primary = str(d.response) || str(d.summary) || str(d.content) || str(d.text);
      return primary || JSON.stringify(d, null, 2);
    }
  }
}

function formatToolCallLabel(tc: ToolCall): string {
  const name = tc.function.name;
  try {
    const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
    if (name === "bash" && typeof args.command === "string") {
      const cmd = args.command.replace(/\n/g, " ").trim();
      return `bash: ${truncate(cmd, 80)}`;
    }
    if (name === "task" && typeof args.agent === "string") {
      const desc = typeof args.description === "string" ? ` — ${args.description}` : "";
      return `task: ${args.agent}${truncate(desc, 60)}`;
    }
    if (name === "read_file" && typeof args.path === "string") {
      return `read: ${args.path}`;
    }
    if ((name === "write_file" || name === "edit_file") && typeof args.path === "string") {
      return `${name === "write_file" ? "write" : "edit"}: ${args.path}`;
    }
  } catch {}
  return name;
}

/**
 * Stateful headless TEXT consumer. Streams tool/error progress to stderr (via
 * {@link renderHeadlessChunk}) but BUFFERS assistant `content` so that a
 * terminal `respond_*` answer ({@link StructuredResponse}) supersedes any
 * preamble the model leaked before calling the response tool — otherwise the
 * answer would print twice (once as raw leaked content, once formatted). For a
 * normal chat turn with no structured answer, the buffered content is flushed
 * verbatim at the end. Mirrors the buffer-and-supersede design of
 * {@link createHeadlessJsonlEmitter}.
 */
export function createHeadlessTextEmitter(): {
  consumeChunk(chunk: StreamChunk): HeadlessWrites;
  flush(): HeadlessWrites;
} {
  let pendingContent = "";
  let structuredEmitted = false;

  function consumeChunk(chunk: StreamChunk): HeadlessWrites {
    switch (chunk.type) {
      case "content":
        pendingContent += chunk.content ?? "";
        return {};
      case "structured_response":
        if (!chunk.structuredResponse) return {};
        // Terminal answer is authoritative — drop any buffered preamble.
        pendingContent = "";
        structuredEmitted = true;
        return { stdout: `${formatStructuredResponseText(chunk.structuredResponse)}\n` };
      case "done":
        // Trailing newline is emitted by flush() alongside the final answer.
        return {};
      default:
        return renderHeadlessChunk(chunk);
    }
  }

  function flush(): HeadlessWrites {
    if (structuredEmitted || pendingContent.length === 0) return {};
    return { stdout: `${pendingContent}\n` };
  }

  return { consumeChunk, flush };
}

function jsonLine(event: HeadlessJsonEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Buffers assistant `content` per step and emits JSONL: step_start, text, tool_use, step_finish, error.
 * Pair with `agent.processMessage(prompt, emitter.observer)` in headless JSON mode only.
 *
 * @param sessionId Agent session id (from {@link Agent.getSessionId}) — included on each JSONL line when set.
 */
export function createHeadlessJsonlEmitter(sessionId?: string): {
  observer: ProcessMessageObserver;
  consumeChunk(chunk: StreamChunk): HeadlessWrites;
  /** Call after the `processMessage` iterator completes to flush any trailing observer output. */
  flush(): HeadlessWrites;
} {
  let pending = "";
  let currentStep = 0;
  let textBuffer = "";
  /** Tool call id → timing from {@link ProcessMessageObserver.onToolStart} / {@link ProcessMessageObserver.onToolFinish}. */
  const toolTiming = new Map<string, { startedAt?: number; finishedAt?: number }>();

  function withSession<T extends Record<string, unknown>>(event: T): T & { sessionID?: string } {
    return sessionId ? { ...event, sessionID: sessionId } : event;
  }

  const observer: ProcessMessageObserver = {
    onStepStart(info: ProcessMessageStepStart) {
      currentStep = info.stepNumber;
      textBuffer = "";
      pending += jsonLine(
        withSession({
          type: "step_start",
          stepNumber: info.stepNumber,
          timestamp: info.timestamp,
        }) as HeadlessJsonEvent,
      );
    },
    onStepFinish(info: ProcessMessageStepFinish) {
      if (textBuffer.length > 0) {
        pending += jsonLine(
          withSession({
            type: "text",
            stepNumber: info.stepNumber,
            text: textBuffer,
            timestamp: Date.now(),
          }) as HeadlessJsonEvent,
        );
        textBuffer = "";
      }
      pending += jsonLine(
        withSession({
          type: "step_finish",
          stepNumber: info.stepNumber,
          timestamp: info.timestamp,
          finishReason: info.finishReason,
          usage: info.usage,
        }) as HeadlessJsonEvent,
      );
    },
    onToolStart(info) {
      const prev = toolTiming.get(info.toolCall.id) ?? {};
      toolTiming.set(info.toolCall.id, { ...prev, startedAt: info.timestamp });
    },
    onToolFinish(info) {
      const prev = toolTiming.get(info.toolCall.id) ?? {};
      toolTiming.set(info.toolCall.id, { ...prev, finishedAt: info.timestamp });
    },
  };

  function drainPending(): string {
    const out = pending;
    pending = "";
    return out;
  }

  function flush(): HeadlessWrites {
    const stdout = drainPending();
    return stdout ? { stdout } : {};
  }

  function consumeChunk(chunk: StreamChunk): HeadlessWrites {
    let stdout = drainPending();

    switch (chunk.type) {
      case "content":
        textBuffer += chunk.content ?? "";
        break;

      case "tool_calls": {
        if (textBuffer.length > 0) {
          stdout += jsonLine(
            withSession({
              type: "text",
              stepNumber: currentStep,
              text: textBuffer,
              timestamp: Date.now(),
            }) as HeadlessJsonEvent,
          );
          textBuffer = "";
        }
        break;
      }

      case "tool_result": {
        if (chunk.toolCall && chunk.toolResult) {
          const id = chunk.toolCall.id;
          const timingEntry = toolTiming.get(id);
          toolTiming.delete(id);

          let timing: { startedAt?: number; finishedAt?: number; durationMs?: number } | undefined;
          if (timingEntry) {
            const startedAt = timingEntry.startedAt;
            const finishedAt = timingEntry.finishedAt;
            if (startedAt !== undefined || finishedAt !== undefined) {
              timing = {};
              if (startedAt !== undefined) timing.startedAt = startedAt;
              if (finishedAt !== undefined) timing.finishedAt = finishedAt;
              if (startedAt !== undefined && finishedAt !== undefined) {
                timing.durationMs = finishedAt - startedAt;
              }
            }
          }

          const eventTime = timingEntry?.finishedAt ?? timingEntry?.startedAt ?? Date.now();
          stdout += jsonLine(
            withSession({
              type: "tool_use",
              stepNumber: currentStep,
              timestamp: eventTime,
              toolCall: chunk.toolCall,
              toolResult: chunk.toolResult,
              ...(timing ? { timing } : {}),
            }) as HeadlessJsonEvent,
          );
        }
        break;
      }

      case "structured_response": {
        if (chunk.structuredResponse) {
          // Flush any buffered preamble text first so ordering is preserved,
          // then emit the typed terminal answer (previously dropped entirely).
          if (textBuffer.length > 0) {
            stdout += jsonLine(
              withSession({
                type: "text",
                stepNumber: currentStep,
                text: textBuffer,
                timestamp: Date.now(),
              }) as HeadlessJsonEvent,
            );
            textBuffer = "";
          }
          stdout += jsonLine(
            withSession({
              type: "structured_response",
              stepNumber: currentStep,
              timestamp: Date.now(),
              taskType: chunk.structuredResponse.taskType,
              data: chunk.structuredResponse.data,
            }) as HeadlessJsonEvent,
          );
        }
        break;
      }

      case "error":
        stdout += jsonLine(
          withSession({
            type: "error",
            message: chunk.content ?? "",
            timestamp: Date.now(),
          }) as HeadlessJsonEvent,
        );
        break;

      case "reasoning":
      case "done":
        break;

      default:
        break;
    }

    return stdout ? { stdout } : {};
  }

  return { observer, consumeChunk, flush };
}
