/**
 * agentic-loop.ts — Tier 2 of Self-QA.
 *
 * Outer LLM (configured provider, e.g. DeepSeek) drives the inner muonroi-cli
 * interactively:
 *
 *   1. Spawn child + wait idle
 *   2. Build context block (current frame + delta vs last + event tail)
 *   3. brain.decide(ctx) → AgenticDecision ({type/press/wait_for/done})
 *   4. Execute decision via Driver
 *   5. Observe new frame + events → loop
 *
 * Terminates when the brain returns `{action: "done"}` OR max turns hit OR
 * the child crashes / disconnects.
 *
 * The brain is pluggable: `createMockBrain` for tests, `createLLMBrain` for
 * production. Brain only needs access to the prompt block + a free-form goal
 * — it knows nothing about Driver internals.
 */

import { resolve } from "node:path";
import { createDriver, type Driver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { spawnAgentTui } from "../agent-harness/test-spawn.js";
import { loadCatalog } from "../models/registry.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import { type AgenticContextBlock, buildAgenticContext } from "./agentic-context.js";

// ── Zod schema for the decision union — used with generateObject to force
// structured output instead of free-text JSON (which reasoning models
// frequently corrupt with thinking prose). ────────────────────────────────
const DecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("type"), text: z.string(), reason: z.string() }),
  z.object({ action: z.literal("press"), key: z.string(), reason: z.string() }),
  z.object({
    action: z.literal("wait_for"),
    selector: z.string().optional(),
    event: z.string().optional(),
    idle: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("done"),
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    reason: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Brain interface — pluggable decision maker
// ---------------------------------------------------------------------------

export type AgenticDecision =
  | { action: "type"; text: string; reason: string }
  | { action: "press"; key: string; reason: string }
  | {
      action: "wait_for";
      selector?: string;
      event?: string;
      idle?: true;
      timeoutMs?: number;
      reason: string;
    }
  | { action: "done"; verdict: "pass" | "fail" | "inconclusive"; reason: string };

export type AgenticBrain = {
  decide(input: {
    goal: string;
    context: AgenticContextBlock;
    historyExcerpt: string;
    turn: number;
    maxTurns: number;
  }): Promise<AgenticDecision>;
};

export type AgenticTurn = {
  turn: number;
  decision: AgenticDecision;
  observedSeq: number | null;
  newEvents: number;
  durationMs: number;
};

export type AgenticReport = {
  goal: string;
  verdict: "pass" | "fail" | "inconclusive";
  reason: string;
  turns: AgenticTurn[];
  totalDurationMs: number;
  events: LiveEvent[];
  finalFrame: LiveFrame | null;
};

// ---------------------------------------------------------------------------
// Mock brain — for tests / deterministic playback
// ---------------------------------------------------------------------------

export function createMockBrain(script: AgenticDecision[]): AgenticBrain {
  let i = 0;
  return {
    async decide() {
      if (i >= script.length) {
        return { action: "done", verdict: "inconclusive", reason: "mock script exhausted" };
      }
      const next = script[i++]!;
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// LLM brain — uses the configured provider stack
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are a QA agent driving a TUI via an agent-harness.
Your job: given a free-form goal and the current TUI state (semantic tree + recent events),
decide the SINGLE next action.

Reply with a strict JSON object — no prose, no markdown fences:

  {"action":"type","text":"...","reason":"short"}
  {"action":"press","key":"Enter|Escape|Down|Up|Tab","reason":"short"}
  {"action":"wait_for","idle":true,"timeoutMs":5000,"reason":"..."}
  {"action":"wait_for","selector":"id=askcard","timeoutMs":5000,"reason":"..."}
  {"action":"wait_for","event":"askcard-open","timeoutMs":5000,"reason":"..."}
  {"action":"done","verdict":"pass","reason":"goal achieved"}
  {"action":"done","verdict":"fail","reason":"goal cannot be achieved"}

Rules:
- One action per turn. Do not batch.
- Prefer wait_for after type/press to let the TUI settle.
- If the goal looks satisfied, return done(pass).
- If an error toast appears or the TUI is stuck, return done(fail).
- Stay within ${"${maxTurns}"} turns. Be concise.`;

export type LLMBrainOptions = {
  /** Model ID, e.g. "deepseek-v4-flash". */
  modelId: string;
  /** System prompt override. */
  systemPrompt?: string;
  /** Max tokens per LLM call. Default 1024 (room for thinking models). */
  maxTokens?: number;
  /** Retry once on unparseable empty output. Default true. */
  retryOnEmpty?: boolean;
};

/**
 * Pull a usable text body out of an AI SDK generateText result.
 *
 * Reasoning models (DeepSeek-V4-Flash, SiliconFlow R1, etc.) sometimes
 * route the visible output to `result.reasoning` instead of `result.text`,
 * or embed thinking inside `<think>…</think>` blocks. This walker tries:
 *
 *   1. `result.text` (canonical)
 *   2. `result.reasoning` (some providers expose only this)
 *   3. Concatenation of `parts[].text` (AI SDK v5+ shape)
 *
 * Then strips `<think>…</think>` so the JSON object emerges cleanly.
 */
function extractBrainText(res: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous SDK result
  const r = res as any;
  const candidates: string[] = [];
  if (typeof r?.text === "string") candidates.push(r.text);
  if (typeof r?.reasoning === "string") candidates.push(r.reasoning);
  if (Array.isArray(r?.content)) {
    for (const p of r.content) if (typeof p?.text === "string") candidates.push(p.text);
  }
  for (const c of candidates) {
    const stripped = c.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (stripped.length > 0) return stripped;
  }
  // Last resort: return whatever was longest, even if it's just thinking text.
  return (candidates.sort((a, b) => b.length - a.length)[0] ?? "").trim();
}

export async function createLLMBrain(opts: LLMBrainOptions): Promise<AgenticBrain> {
  // 1) Silence the cosmetic "responseFormat schema only supported with
  //    structuredOutputs" warning — we know DeepSeek only supports
  //    response_format={type:"json_object"} and the strategy sets
  //    supportsStructuredOutputs=false; the warning is informational.
  // 2) Default-on thinking disable for DeepSeek so JSON-only output
  //    flows without reasoning prose leaking through.
  // biome-ignore lint/suspicious/noExplicitAny: global flag is AI SDK's docs convention
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
  if (process.env.MUONROI_DEEPSEEK_DISABLE_THINKING === undefined) {
    process.env.MUONROI_DEEPSEEK_DISABLE_THINKING = "1";
  }

  // Resolve the catalog before any model lookup — resolveModelRuntime needs it
  // loaded or it throws "not found in catalog". self-verify --agentic is a
  // standalone entrypoint that never ran the main boot's loadCatalog(). F13.
  await loadCatalog();

  const provider = detectProviderForModel(opts.modelId);
  if (!provider) throw new Error(`No provider detected for model '${opts.modelId}'`);
  const apiKey = await loadKeyForProvider(provider);
  if (!apiKey) throw new Error(`No API key found for provider '${provider}'`);
  // Registers the factory so resolveModelRuntime can derive it from the model.
  createProviderFactory(provider, { apiKey });
  const runtime = resolveModelRuntime(opts.modelId);
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxTokens = opts.maxTokens ?? 1024;
  const retryOnEmpty = opts.retryOnEmpty !== false;

  // @ai-sdk/openai-compatible's chat schema exposes `strictJsonSchema: false`
  // for providers that don't honour OpenAI's strict JSON schema mode.
  // DeepSeek only supports `response_format: {type: "json_object"}` — it
  // rejects the full
  // schema response_format. Setting strictJsonSchema=false makes AI SDK fall
  // back to lenient json_object mode silently (no "responseFormat not
  // supported" warning) while still steering the model toward JSON output.
  //
  // Disabling DeepSeek thinking mode would require `extra_body.thinking
  // .type=disabled` per https://api-docs.deepseek.com/guides/thinking_mode
  // — but openai-compatible v2.0.42 does not expose a generic extraBody
  // knob, so that's left to a future provider patch.
  const mergedProviderOptions: Record<string, Record<string, unknown>> = {
    ...((runtime.providerOptions ?? {}) as Record<string, Record<string, unknown>>),
  };
  if (provider === "deepseek") {
    mergedProviderOptions[provider] = {
      ...(mergedProviderOptions[provider] ?? {}),
      strictJsonSchema: false,
    };
  }

  async function callStructured(userPrompt: string): Promise<AgenticDecision | null> {
    try {
      const res = await generateObject({
        model: runtime.model,
        schema: DecisionSchema,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: maxTokens,
        // biome-ignore lint/suspicious/noExplicitAny: AI SDK ProviderOptions type is too narrow for dynamic builds
        providerOptions: mergedProviderOptions as any,
      });
      return res.object as AgenticDecision;
    } catch {
      return null;
    }
  }

  async function callFreeText(userPrompt: string): Promise<{ text: string; decision: AgenticDecision | null }> {
    const res = await generateText({
      model: runtime.model,
      system: `${systemPrompt}\n\nReply with ONE LINE of JSON only. No prose, no markdown fences, no <think> blocks.`,
      prompt: userPrompt,
      maxOutputTokens: maxTokens,
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK ProviderOptions type is too narrow for dynamic builds
      providerOptions: mergedProviderOptions as any,
    });
    const text = extractBrainText(res);
    return { text, decision: parseDecision(text) };
  }

  return {
    async decide({ goal, context, historyExcerpt, turn, maxTurns }) {
      const userPrompt = [
        `## Goal`,
        goal,
        ``,
        `## Turn ${turn}/${maxTurns}`,
        ``,
        `## History (most recent decisions)`,
        historyExcerpt || "(no prior turns)",
        ``,
        `## TUI state`,
        context.prompt,
        ``,
        `## Your reply — emit a single structured decision now.`,
      ].join("\n");

      // Primary path: structured output (forces schema-conformant JSON).
      const structured = await callStructured(userPrompt);
      if (structured) return structured;

      // Fallback: free-text generateText + parseDecision, with one retry.
      const first = await callFreeText(userPrompt);
      if (first.decision) return first.decision;
      let lastText = first.text;
      if (retryOnEmpty) {
        const stricter = `${userPrompt}\n\nReminder: emit exactly one JSON object such as {"action":"press","key":"Enter","reason":"..."}. Nothing else.`;
        const second = await callFreeText(stricter);
        if (second.decision) return second.decision;
        lastText = second.text || lastText;
      }
      return {
        action: "done",
        verdict: "inconclusive",
        reason: `Brain emitted unparseable output: ${lastText.slice(0, 200) || "(empty)"}`,
      };
    },
  };
}

export function parseDecision(raw: string): AgenticDecision | null {
  // Strip ```json fences if any LLM ignores instructions.
  const trimmed = raw
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  // Scan for every {...} candidate (brace-balanced) and try each, biggest first.
  const candidates = extractJsonCandidates(trimmed);
  for (const slice of candidates) {
    const parsed = tryParseDecisionSlice(slice);
    if (parsed) return parsed;
  }
  // Last-resort: span from first { to last } as a single attempt.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return tryParseDecisionSlice(trimmed.slice(start, end + 1));
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try longest first — usually the most complete object.
  return out.sort((a, b) => b.length - a.length);
}

function tryParseDecisionSlice(slice: string): AgenticDecision | null {
  try {
    const obj = JSON.parse(slice) as Record<string, unknown>;
    if (typeof obj.action !== "string") return null;
    const action = obj.action;
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    switch (action) {
      case "type":
        if (typeof obj.text === "string") return { action, text: obj.text, reason };
        return null;
      case "press":
        if (typeof obj.key === "string") return { action, key: obj.key, reason };
        return null;
      case "wait_for": {
        const w: AgenticDecision = {
          action,
          reason,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : 5_000,
        };
        if (obj.idle === true) w.idle = true;
        if (typeof obj.selector === "string") w.selector = obj.selector;
        if (typeof obj.event === "string") w.event = obj.event;
        return w;
      }
      case "done": {
        const v = obj.verdict;
        if (v === "pass" || v === "fail" || v === "inconclusive") {
          return { action, verdict: v, reason };
        }
        return null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export type AgenticLoopOptions = {
  goal: string;
  brain: AgenticBrain;
  maxTurns?: number;
  /** Total wall-clock budget for the loop. Default 5 min. */
  budgetMs?: number;
  entry?: string;
  mockLlmDir?: string;
  /** Extra CLI args appended after --agent-mode --mock-llm <dir>. */
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Node IDs always re-rendered verbatim in context (e.g. ["askcard"]). */
  pinIds?: string[];
};

export async function runAgenticLoop(opts: AgenticLoopOptions): Promise<AgenticReport> {
  const log = opts.log ?? (() => {});
  const maxTurns = opts.maxTurns ?? 20;
  const budget = opts.budgetMs ?? 5 * 60_000;
  const startedAt = Date.now();
  const events: LiveEvent[] = [];
  let lastFrame: LiveFrame | null = null;

  const entry = opts.entry ?? resolve("src/index.ts");
  const args = [entry, "--agent-mode"];
  if (opts.mockLlmDir !== "none") {
    const mockDir = opts.mockLlmDir ?? resolve("tests/harness/fixtures/llm");
    args.push("--mock-llm", mockDir);
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MUONROI_TEST_NO_PERSIST: "1",
    MUONROI_INTERNAL_SHIM_OK: "1",
    ...(opts.env ?? {}),
  };

  log(`[agentic] Spawning child: ${entry}`);
  const spawn = await spawnAgentTui(args, { spawnOpts: { env } });
  const driver = wireDriver(spawn.inWrite, spawn.outRead);

  // Collect every event into the bus.
  void (async () => {
    try {
      for await (const e of driver.events()) events.push(e);
    } catch {}
  })();

  let crashed = false;
  let crashReason = "";
  spawn.proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      crashed = true;
      crashReason = `child exited code=${code} signal=${signal ?? "none"}`;
    }
    driver._closeAllSubscribers();
  });

  const turns: AgenticTurn[] = [];
  let verdict: "pass" | "fail" | "inconclusive" = "inconclusive";
  let reason = "loop terminated without explicit verdict";

  try {
    // Initial idle.
    try {
      await driver.wait_for({ idle: true, timeoutMs: 15_000 });
    } catch {}
    lastFrame = driver.snapshot();

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (Date.now() - startedAt > budget) {
        verdict = "inconclusive";
        reason = `wall-clock budget ${budget}ms exhausted at turn ${turn}`;
        break;
      }
      if (crashed) {
        verdict = "inconclusive";
        reason = crashReason;
        break;
      }

      const before = driver.snapshot();
      const eventsBefore = events.length;
      const context = buildAgenticContext(lastFrame, before, events.slice(-20), {
        pinIds: opts.pinIds ?? ["askcard"],
      });
      const historyExcerpt = turns
        .slice(-5)
        .map((t) => {
          const d = t.decision;
          let detail = "";
          if (d.action === "type") detail = ` text=${JSON.stringify(d.text)}`;
          else if (d.action === "press") detail = ` key=${d.key}`;
          else if (d.action === "wait_for") detail = ` ${d.idle ? "idle" : (d.selector ?? d.event ?? "")}`;
          return `T${t.turn}: ${d.action}${detail} — ${truncate(d.reason, 60)}`;
        })
        .join("\n");

      log(`[agentic] T${turn}/${maxTurns} — context ~${context.estimatedTokens} tokens`);
      const t0 = Date.now();
      let decision: AgenticDecision;
      try {
        decision = await opts.brain.decide({
          goal: opts.goal,
          context,
          historyExcerpt,
          turn,
          maxTurns,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        verdict = "inconclusive";
        reason = `brain.decide threw: ${msg}`;
        turns.push({
          turn,
          decision: { action: "done", verdict: "inconclusive", reason: msg },
          observedSeq: before?.seq ?? null,
          newEvents: 0,
          durationMs: Date.now() - t0,
        });
        break;
      }

      log(`[agentic]   → ${decision.action}${"reason" in decision ? `: ${truncate(decision.reason, 60)}` : ""}`);

      if (decision.action === "done") {
        verdict = decision.verdict;
        reason = decision.reason;
        turns.push({
          turn,
          decision,
          observedSeq: before?.seq ?? null,
          newEvents: events.length - eventsBefore,
          durationMs: Date.now() - t0,
        });
        break;
      }

      try {
        await executeDecision(driver, decision);
        if (decision.action === "type" || decision.action === "press") {
          await new Promise((res) => setTimeout(res, 300));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // wait_for timeouts are common — brain gets to see and adapt.
        log(`[agentic]     (action threw: ${truncate(msg, 80)})`);
      }

      lastFrame = before;
      turns.push({
        turn,
        decision,
        observedSeq: driver.snapshot()?.seq ?? null,
        newEvents: events.length - eventsBefore,
        durationMs: Date.now() - t0,
      });
    }
  } finally {
    try {
      spawn.proc.kill();
    } catch {}
    spawn.cleanup();
  }

  return {
    goal: opts.goal,
    verdict,
    reason,
    turns,
    totalDurationMs: Date.now() - startedAt,
    events,
    finalFrame: lastFrame,
  };
}

async function executeDecision(driver: Driver, d: AgenticDecision): Promise<void> {
  switch (d.action) {
    case "type":
      driver.type(d.text);
      return;
    case "press":
      driver.press(d.key);
      return;
    case "wait_for": {
      const timeout = d.timeoutMs ?? 5_000;
      if (d.idle) return driver.wait_for({ idle: true, timeoutMs: timeout });
      if (d.selector) return driver.wait_for({ selector: d.selector, timeoutMs: timeout });
      if (d.event) return driver.wait_for({ event: d.event, timeoutMs: timeout });
      return;
    }
    case "done":
      return;
  }
}

function wireDriver(inWrite: NodeJS.WritableStream, outRead: NodeJS.ReadableStream): Driver {
  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });
  const splitter = createLineSplitter((line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      else if (msg.t === "idle") driver._ingest({ kind: "idle" });
      else if (msg.t === "event") driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
    } catch {}
  });
  outRead.on("data", (chunk: Buffer | string) => {
    splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  return driver;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
