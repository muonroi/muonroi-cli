/**
 * Executor-side guard for malformed tool calls — the "keyless / marker-args"
 * loop breaker.
 *
 * ## What it is for (measured, session 2026-09-08 sub-agent run)
 *
 * A sub-agent ran 176 steps over ~19 minutes and shipped nothing. The chain:
 *
 *  1. `subagent-compactor` replaces OLD tool-call arguments in history with
 *     `{"__elided_note":"[earlier call args elided by sub-agent compactor —
 *     NNN chars; …]"}` so the billed prefix stops growing.
 *  2. The model IMITATED that shape in FRESH calls. Proof it is imitation and
 *     not a logging artifact: the sentence exists in exactly two places in this
 *     repo's source, ZERO times in the 1,797 files of the repo the sub-agent was
 *     working in and zero times in any tool result — yet it appears in the
 *     model's own output with 69 distinct fabricated `— NNN chars` values across
 *     5 different tools. It learned the template.
 *  3. 267 elided-shape calls were issued; 266 failed. The single survivor was
 *     `compact`, which takes no arguments.
 *  4. `read_file` failed 184× with `The "path" property must be of type string,
 *     got undefined`; `grep` 71× with `pattern is required`. Correlation was
 *     total: for `read_file`, elided-args ⟺ failure is 184/184, against 142
 *     non-elided `read_file` calls with ZERO failures.
 *  5. `bash` and `write_file` already HAD per-tool guards and correctly blocked.
 *     `bash`'s 3-strike escalation then told the model to "use read_file, grep,
 *     or other tools instead" — i.e. it redirected the agent into precisely the
 *     two tools that had no guard. From step 103 to 175, 100% of calls were
 *     malformed.
 *
 * ## Why it must live at the executor, not in the schema
 *
 * `grep` DOES declare `required:["pattern"]` and still received 94 keyless
 * calls. The provider does not enforce the schema it is shown, so adding
 * `required` to a schema is not a fix. The only place a malformed call can be
 * stopped is the executor it is about to enter — here.
 *
 * ## Design notes
 *
 *  - The elision predicate is IMPORTED from the compactor that produces the
 *    marker (`carriesElidedArgsMarker`, which covers the top-level input AND any
 *    argument slot the marker lands in), never copied. One definition means a
 *    future change to the marker cannot leave a stale twin behind that silently
 *    stops matching — and the loop terminator below keys on the SAME predicate,
 *    so it can never count a different population than this guard blocks.
 *  - A blocked call NEVER reaches the underlying `execute`. Inertness is
 *    load-bearing: a marker shaped like real arguments would otherwise
 *    overwrite a source file with the marker text.
 *  - Escalation follows the `bash` empty-command precedent (registry.ts) so a
 *    model that keeps repeating gets a stronger signal instead of the same
 *    sentence forever. The streak is per-session and shared ACROSS tools,
 *    because the observed failure alternated between `read_file` and `grep`.
 *  - No guidance names another tool. That is what turned a bash-only stall into
 *    a whole-session stall.
 *
 * ## Blocking is not terminating (measured again 2026-09-25)
 *
 * This guard bounds the DAMAGE of a malformed call, never its COUNT. `/ideal` run
 * muc2joffe506 (session bf39c59e4dd1) produced 29 blocked results in ~10 minutes
 * and a sub-agent climbing past stepIndex 211; the escalation ladder below just
 * kept counting ("N malformed tool calls in a row") and the run died
 * `phases-deadlocked` with score 0. Asking a model to stop is not a bound, and a
 * louder message here would not be one either.
 *
 * The bound lives in `src/orchestrator/no-progress-guard.ts`, which refuses to
 * treat a call this guard rejected as new information. Keep the two coherent:
 * anything added here as a NEW block class is still unbounded until that guard
 * can recognise it.
 */

import { carriesElidedArgsMarker } from "../orchestrator/subagent-compactor.js";
import { logger } from "../utils/logger.js";

declare global {
  // Session-scoped consecutive-malformed-call counter. Process-global (not a
  // closure local) for the same reason the bash repeat detector is: the tool
  // registry is rebuilt between turns / askcards / sub-agent hops, and a
  // per-closure counter resets to 0 on every rebuild — exactly the condition
  // under which the observed loop ran for 176 steps.
  var __muonroiMalformedArgStreak: Map<string, number> | undefined;
}

function streakState(): Map<string, number> {
  if (!globalThis.__muonroiMalformedArgStreak) {
    globalThis.__muonroiMalformedArgStreak = new Map<string, number>();
  }
  return globalThis.__muonroiMalformedArgStreak;
}

interface ArgGuardSchema {
  properties?: Record<string, { type?: string } | undefined>;
  required?: string[];
}

/**
 * Tools whose real contract is "at least ONE of these keys". JSON Schema
 * `required` is an AND, so it cannot express it, and `read_file` therefore
 * ships with no `required` array at all — which is why 184 keyless `read_file`
 * calls sailed straight into `readFile(undefined, …)`.
 *
 * Keep this table minimal: a tool belongs here ONLY when its declared schema
 * genuinely cannot state the requirement.
 */
const REQUIRED_ANY: Readonly<Record<string, readonly string[]>> = {
  read_file: ["file_path", "file_paths"],
};

type ArgGuardKind = "elision-marker-as-args" | "missing-required-args";

interface ArgGuardVerdict {
  kind: ArgGuardKind;
  /** Argument names the call must supply. */
  missing: string[];
  /** True when `missing` is an "at least one of" set rather than "all of". */
  anyOf: boolean;
}

/** Unwrap the raw JSON Schema out of an AI-SDK `jsonSchema(...)` wrapper. */
function extractJsonSchema(inputSchema: unknown): ArgGuardSchema | null {
  if (!inputSchema || typeof inputSchema !== "object") return null;
  const wrapper = inputSchema as { jsonSchema?: unknown };
  const raw = (wrapper.jsonSchema ?? inputSchema) as ArgGuardSchema;
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

/**
 * Presence check. Deliberately NOT an emptiness check: `write_file` may write
 * an empty file, so `content:""` is a legal argument. Blank-string semantics
 * stay in the per-tool guards that know what blank means for that tool; this
 * layer answers only "did the model supply this argument at all, in the
 * declared shape".
 */
function isSupplied(value: unknown, declaredType: string | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (declaredType === "string" && typeof value !== "string") return false;
  if (declaredType === "array" && (!Array.isArray(value) || value.length === 0)) return false;
  return true;
}

function evaluateToolArgs(toolName: string, input: unknown, schema: ArgGuardSchema | null): ArgGuardVerdict | null {
  const args: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  const anyKeys = REQUIRED_ANY[toolName];
  const props = schema?.properties ?? {};
  const requiredAll = Array.isArray(schema?.required) ? schema.required : [];

  // 1. The elision marker, at the top level or in any argument slot. Always a
  //    block, for every tool, even one that takes no arguments: the marker is
  //    proof the model is quoting compacted history rather than deciding.
  if (carriesElidedArgsMarker(input)) {
    // A tool whose parameters are ALL optional must not be told to "supply a
    // non-empty <optional key>" — `{}` is the correct re-issue for it. That is
    // exactly `compact`, the one call out of 267 that used to survive.
    const expected = anyKeys ? [...anyKeys] : [...requiredAll];
    return { kind: "elision-marker-as-args", missing: expected, anyOf: Boolean(anyKeys) };
  }

  // 2. "At least one of" contracts the schema cannot state.
  if (anyKeys && !anyKeys.some((k) => isSupplied(args[k], props[k]?.type))) {
    return { kind: "missing-required-args", missing: [...anyKeys], anyOf: true };
  }

  // 3. Schema-declared `required`, enforced HERE because the provider does not.
  const missing = requiredAll.filter((k) => !isSupplied(args[k], props[k]?.type));
  if (missing.length > 0) {
    return { kind: "missing-required-args", missing, anyOf: false };
  }

  return null;
}

/** A copyable placeholder so the corrective message shows a call that works. */
function sampleValue(key: string, declaredType: string | undefined): unknown {
  if (declaredType === "array") return ["src/foo.ts"];
  if (declaredType === "number" || declaredType === "integer") return 1;
  if (declaredType === "boolean") return true;
  if (/path|file/i.test(key)) return "src/foo.ts";
  if (/pattern|query|search/i.test(key)) return "TODO";
  if (/command/i.test(key)) return "ls -la";
  return "<value>";
}

function sampleCall(verdict: ArgGuardVerdict, schema: ArgGuardSchema | null): string {
  const props = schema?.properties ?? {};
  // For an "at least one of" contract, show ONE key — showing both would
  // suggest the model must supply both.
  const keys = verdict.anyOf ? verdict.missing.slice(0, 1) : verdict.missing;
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = sampleValue(k, props[k]?.type);
  return JSON.stringify(obj);
}

function formatArgGuardMessage(
  toolName: string,
  verdict: ArgGuardVerdict,
  strike: number,
  schema: ArgGuardSchema | null,
): string {
  const names = verdict.missing.join(verdict.anyOf ? " or " : ", ");
  const reissue =
    verdict.missing.length === 0
      ? "Re-issue it with real arguments — every parameter of this tool is optional, so {} is a valid call."
      : `Re-issue with a non-empty ${names}, e.g. ${sampleCall(verdict, schema)}.`;

  // The `BLOCKED (<kind>):` prefix is not only prose — for the `bash` tool it
  // is a wire protocol. `parseSafetyBlock` (src/orchestrator/safety-intercept.ts)
  // reads the kind out of bash's tool result, and tool-engine.ts:2913 auto-blocks
  // ONLY the established `empty-bash` kind; every other kind opens an
  // interactive safety-override askcard. Emitting a NEW kind for bash would pop
  // a modal per malformed call — and a kind with no entry in the askcard's label
  // map. So bash keeps its existing token (the statement "this bash call had no
  // usable command" is true either way) and the corrective body still explains
  // the real mistake. No other tool's output reaches that parser.
  const kindToken = toolName === "bash" ? "empty-bash" : verdict.kind;

  const head =
    verdict.kind === "elision-marker-as-args"
      ? `BLOCKED (${kindToken}): "__elided_note" is a history-compaction marker this CLI substitutes for the arguments of OLD tool calls — it is not a callable argument, and this ${toolName} call was NOT executed. ` +
        `Never copy argument text out of earlier tool calls in this conversation; write the arguments fresh. ${reissue}`
      : `BLOCKED (${kindToken}): ${toolName} was called without usable arguments — missing ${names}. ` +
        `The call was NOT executed. Supply a non-empty value, e.g. ${sampleCall(verdict, schema)}.`;

  if (strike >= 3) {
    return (
      `${head} [${strike} malformed tool calls in a row this session; none of them ran. ` +
      `STOP issuing tool calls now and reply in plain text: say what you were trying to do and which argument values you do not have. ` +
      `Argument names must come from the tool schema you were shown, never from earlier tool-call arguments in this conversation.]`
    );
  }
  if (strike >= 2) {
    return `${head} [${strike} malformed tool calls in a row this session; none of them ran. Read the tool schema above and copy the argument names from it before the next call.]`;
  }
  return head;
}

interface GuardableTool {
  inputSchema?: unknown;
  execute?: (...args: unknown[]) => unknown;
}

/**
 * Idempotence marker, and the answer to "is this tool guarded at all?".
 * Every register* helper builds fresh `dynamicTool(...)` objects per
 * `createBuiltinTools()` call today, so double-installation cannot happen — but
 * a module-level tool singleton introduced later would otherwise accumulate one
 * wrapper per registry rebuild. `{...tool}` (how every outer wrapper clones a
 * tool) copies own enumerable symbol keys, so the marker survives all of them.
 */
const GUARD_INSTALLED = Symbol.for("muonroi.argGuardInstalled");

/**
 * F3 — "will the executor-side guard refuse to RUN this call?"
 *
 * The tool-set wrappers layered outside the registry (sub-agent cap,
 * cross-turn dedup, read-path budget) either post-process a tool's result or
 * pre-empt it with a stub. A call this guard rejects **never ran**, so it has
 * no prior result to point at — and every one of those stubs says some form of
 * "you already have this answer, reuse it".
 *
 * Measured (2026-09-09): three malformed calls were blocked in one run. The two
 * whose correction reached the model (15:16:54, 15:28:51) were each repaired on
 * the very next call. The third (15:30:21, repeated 15:30:27) had its correction
 * replaced by the cap's `[dup of call #171 — reuse it]` stub, because the guard's
 * corrective message is itself a tool output and hashed equal to an earlier
 * correction. The model was told to reuse the answer to a call that had never
 * once succeeded, learned nothing, and repeated the shape.
 *
 * The outer wrappers ask THIS function rather than re-deriving the rule, so the
 * bypass can never drift from what the guard actually blocks. It returns true
 * only when the guard is genuinely installed on `tool`: an un-guarded tool (an
 * MCP tool, say) has nobody to speak for it, so dedup/cap/budget keep their
 * normal behaviour there.
 *
 * Never throws — a probe that cannot decide must not be able to disable dedup.
 */
export function isGuardRejectableCall(tool: unknown, toolName: string, input: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const candidate = tool as GuardableTool & { [GUARD_INSTALLED]?: boolean };
  if (!candidate[GUARD_INSTALLED]) return false;
  try {
    return evaluateToolArgs(toolName, input, extractJsonSchema(candidate.inputSchema)) !== null;
  } catch (err) {
    logger.warn("orchestrator", "[tools/arg-guard] rejectability probe failed; treating call as well-formed", {
      tool: toolName,
      error: (err as Error)?.message,
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    return false;
  }
}

/**
 * Wrap every tool's `execute` with the guard. Called once at the end of
 * `createBuiltinTools`, after every register* helper has contributed, so no
 * builtin can be added later without inheriting the guard.
 *
 * `sessionKey` must be stable across registry rebuilds within one session
 * (registry.ts derives it the same way the git-safety gate does) — otherwise
 * the escalation counter resets on every rebuild.
 */
export function installArgGuards(tools: Record<string, unknown>, sessionKey: string): void {
  for (const [toolName, entry] of Object.entries(tools)) {
    const tool = entry as GuardableTool & { [GUARD_INSTALLED]?: boolean };
    if (typeof tool?.execute !== "function") continue;
    if (tool[GUARD_INSTALLED]) continue;
    tool[GUARD_INSTALLED] = true;
    const schema = extractJsonSchema(tool.inputSchema);
    const inner = tool.execute.bind(tool);

    tool.execute = async (...callArgs: unknown[]): Promise<unknown> => {
      const input = callArgs[0];
      let verdict: ArgGuardVerdict | null = null;
      try {
        verdict = evaluateToolArgs(toolName, input, schema);
      } catch (err) {
        // The guard must never be the reason a legitimate call fails. Log
        // loudly and fall through to the real executor.
        logger.warn("orchestrator", "[tools/arg-guard] guard evaluation failed; executing unguarded", {
          tool: toolName,
          error: (err as Error)?.message,
          stack: (err as Error)?.stack?.split("\n").slice(0, 3),
        });
        verdict = null;
      }

      const state = streakState();
      if (!verdict) {
        state.delete(sessionKey);
        return await inner(...callArgs);
      }

      const strike = (state.get(sessionKey) ?? 0) + 1;
      state.set(sessionKey, strike);
      const message = formatArgGuardMessage(toolName, verdict, strike, schema);
      logger.warn("orchestrator", "[tools/arg-guard] blocked malformed tool call", {
        tool: toolName,
        kind: verdict.kind,
        missing: verdict.missing,
        strike,
      });
      // `{success:false, output}` is the shape `toToolResult` already
      // understands (same as the write_file guard), so the block renders as a
      // tool error everywhere instead of "[object Object]".
      return { success: false, output: message };
    };
  }
}
