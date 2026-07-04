/**
 * tests/harness/recording.ts
 *
 * Helpers for cost-leak verification specs that drive the orchestrator with a
 * mock model installed via `installMockModel(...)`. The mock's `doStreamCalls`
 * captures every `streamText` invocation; these helpers extract the bits a
 * cost-leak assertion actually needs (params, providerOptions, role,
 * cumulative prompt size).
 */

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";

export type CallRole = "top-level" | "sub-agent" | "unknown";

export interface InspectedCall {
  /** Position in the doStreamCalls array (0-based). */
  index: number;
  /** Raw options object captured by MockLanguageModelV3. */
  options: LanguageModelV3CallOptions;
  /** Concatenated text of every system message in the prompt. */
  systemText: string;
  /** Concatenated text of every user message in the prompt. */
  userText: string;
  /** Concatenated text of every assistant message in the prompt. */
  assistantText: string;
  /**
   * Char count of all message content text. Coarse proxy for the bytes sent to
   * the provider, sufficient for B3/B4 compaction assertions.
   */
  promptChars: number;
  /**
   * Role inferred from the system prompt. Sub-agent prompts begin with
   * "You are the {Type} sub-agent" — see src/orchestrator/prompts.ts.
   */
  role: CallRole;
}

interface MockHandleLike {
  readonly calls: ReadonlyArray<LanguageModelV3CallOptions>;
}

function extractTextByRole(prompt: LanguageModelV3Prompt, role: "system" | "user" | "assistant"): string {
  const parts: string[] = [];
  for (const msg of prompt) {
    if (msg.role !== role) continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "text") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function promptCharCount(prompt: LanguageModelV3Prompt): number {
  let total = 0;
  for (const msg of prompt) {
    if (typeof msg.content === "string") {
      total += msg.content.length;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "text") total += part.text.length;
      else if (part.type === "tool-result") {
        // Tool results are part of the message bytes; approximate via JSON serialization.
        total += JSON.stringify(part.output ?? "").length;
      } else if (part.type === "tool-call") {
        // `input` is normalized by the AI SDK to whatever the provider expects
        // — string for legacy providers, object for v6+ tool definitions.
        // Both contribute bytes; serialize uniformly so promptChars never NaNs.
        const input = part.input;
        const inputLen = typeof input === "string" ? input.length : JSON.stringify(input ?? "").length;
        total += inputLen + part.toolName.length;
      }
    }
  }
  return total;
}

function inferRole(systemText: string): CallRole {
  // The sub-agent role line is "You are the {Type} sub-agent" (see
  // src/orchestrator/prompts.ts). It used to be the first line of the system
  // prompt, but an "[ENV] OS=…" preamble (and the AGENT OPERATING CONTRACT
  // block) is now prepended, so a `^`-anchored match no longer fires and every
  // sub-agent call was misclassified as top-level. Match the role line anywhere
  // in the prompt but keep it on a single line ([^\n]*) so a top-level prompt
  // that merely MENTIONS "sub-agent" in a tool description can't false-positive
  // (those never contain the literal "You are the … sub-agent" phrase).
  if (/You are the\b[^\n]*\bsub-agent\b/i.test(systemText)) return "sub-agent";
  if (systemText.length > 0) return "top-level";
  return "unknown";
}

/** Lift a recorded call into the inspection shape. */
export function inspectCall(options: LanguageModelV3CallOptions, index: number): InspectedCall {
  const systemText = extractTextByRole(options.prompt, "system");
  const userText = extractTextByRole(options.prompt, "user");
  const assistantText = extractTextByRole(options.prompt, "assistant");
  return {
    index,
    options,
    systemText,
    userText,
    assistantText,
    promptChars: promptCharCount(options.prompt),
    role: inferRole(systemText),
  };
}

/** All recorded calls, in order. */
export function inspectAll(handle: MockHandleLike): InspectedCall[] {
  return handle.calls.map((c, i) => inspectCall(c, i));
}

/** Calls filtered by inferred role. */
export function inspectByRole(handle: MockHandleLike, role: CallRole): InspectedCall[] {
  return inspectAll(handle).filter((c) => c.role === role);
}

/** Sum of `promptChars` across every recorded call — for B3/B4 cumulative checks. */
export function cumulativePromptChars(handle: MockHandleLike): number {
  return inspectAll(handle).reduce((sum, c) => sum + c.promptChars, 0);
}

/**
 * Assertion sugar: throws if the given param is present on the call. Use this
 * to verify G1-style filtering ("OAuth backend rejects maxOutputTokens").
 */
export function assertParamAbsent(
  call: LanguageModelV3CallOptions | InspectedCall,
  param: "maxOutputTokens" | "temperature" | "topP",
): void {
  const opts = "options" in call ? call.options : call;
  if (opts[param] !== undefined) {
    throw new Error(`expected ${param} to be omitted; got ${String(opts[param])}`);
  }
}

/**
 * Assertion sugar: throws if the given param is missing. Use in control tests
 * that verify a param IS forwarded when not in `unsupportedParams`.
 */
export function assertParamPresent(
  call: LanguageModelV3CallOptions | InspectedCall,
  param: "maxOutputTokens" | "temperature" | "topP",
): void {
  const opts = "options" in call ? call.options : call;
  if (opts[param] === undefined) {
    throw new Error(`expected ${param} to be present; got undefined`);
  }
}

/**
 * Phase H3 — load recordings dumped from a child process by `dumpRecordings`.
 * Returns the same `InspectedCall` shape as `inspectAll`, so cumulative /
 * role / param helpers all work identically against dumped data.
 *
 * Strict: throws when the file is missing or not an array of call options.
 */
export function loadDumpedRecordings(path: string): InspectedCall[] {
  // biome-ignore lint/correctness/noNodejsModules: test-only helper
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const raw = fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`loadDumpedRecordings: expected array at ${path}`);
  }
  return parsed.map((opts, i) => inspectCall(opts as LanguageModelV3CallOptions, i));
}

/** Extract a nested providerOptions field for assertion. */
export function getProviderOption<T = unknown>(
  call: LanguageModelV3CallOptions | InspectedCall,
  providerKey: string,
  optionKey: string,
): T | undefined {
  const opts = "options" in call ? call.options : call;
  const provider = opts.providerOptions?.[providerKey] as Record<string, unknown> | undefined;
  return provider?.[optionKey] as T | undefined;
}
