/** Host-owned guidance only. Loading a module never grants a tool or authorization. */
export const TASK_STAGES = ["orient", "research", "plan", "implement", "verify"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

export function progressiveContextEnabled(): boolean {
  return process.env.MUONROI_PROGRESSIVE_CONTEXT !== "0";
}

export const WORKING_CONTEXT_GUIDANCE = `Context hygiene: use context_load(topic="working_set",action="inspect"), then update the current task/constraints/decisions/open items and retire unrelated closed turns with archive or archive_through. Keep negative evidence and dependency tool/turn IDs. Replace stale ledger fields, not append a session story. replace_checkpoint explicitly retires an old summary after carrying valid state forward. reset/restore_turn_ids restores available history; compact remains the overflow fallback. Context selection grants no permission.`;

export const TASK_CONTEXT_CORE = `[NATIVE CAPABILITIES — progressive task context]
Call exposed tools directly; list_tools / list_mcp_servers show availability and describe_tool supplies parameters. Native tools do not require a self-spawned MCP server. Missing tools must be reported, never invented.
- read_file / grep for source/config/log text; no LSP prerequisite. lsp_query / wait_for_diagnostics / impact_of_change for semantic questions; partial/unavailable diagnostics are incomplete evidence.
- bash output is cached: use sufficient returned output directly; bash_output_get retrieves missing slices without rerunning. Preserve full build/test/failure output and exit codes; focused read-only pipes are allowed. Use background execution for servers/watchers.
- EE is native: recall before unfamiliar/risky work, rate used handles and save proven lessons. ee_query({query}) uses task/cwd scope; pass cwd or project once for another repo and strict success remembers it for this task. action=scope inspects, projects discovers slugs, reset returns to shell scope. ee_health separates reachability from lastRecall. ee_write reuses verified scope; ee_feedback rates shown handles in their original scope. Unavailable recall cannot block main. Rehydrate by exact tool-artifact ID or retrieve_tool_result(tool_call_id=...).
- Stage guidance follows successful native reads, edits and verification without extra calls. context_load explicitly selects orient/research/plan/implement/verify and pins that choice for this run, with a bounded handoff for the NEXT request. Select a stage when intent differs from observed work; skip/revisit freely. It also pages/searches skill metadata or the CLI reference. Read selected SKILL.md before using it; named/repo-required skills remain discoverable.
- task(agent="explore", ...) is read-only research; task general executes assigned work; verify validates its scope. delegate(agent="explore", ...) runs background research. Main chooses useful independent work, owns final acceptance, and collects versioned results; do not poll unfinished jobs. Delegation adds its own requests.
- Children retain repository custom instructions and ownership boundaries; the full skills catalog is omitted for children, which get skill names plus skill_load. Only the actual granted tools are callable.
VERIFICATION ROUTING: pure discussion needs no harness. Default to verification_run for explicit local tests: Vitest/Jest/Mocha, JavaScript node:test, or Python pytest in .venv. Auto selects only an unambiguous installed runner; otherwise choose runner explicitly. Use bash for other repo workflows/builds, without duplicate runs. UI/harness/workflow changes additionally require selfverify_start(mode="tier1", emit=false, files=[task-owned files]) and status/result. Agentic selfverify can use paid calls. Honor repo-required checks; TUI pass is not logic verification.
FLOW tools coordinate code workflows when required; context stages do not pass plan review or unlock mutations. The runtime permission/sandbox snapshot is descriptive; tool guards and audit remain authoritative. Never claim sandbox isolation from configuration alone. Resolve models/providers from catalog/settings/runtime, never hardcode IDs. Log caught errors with context, HTTP status/body when applicable, and redact secrets.
${WORKING_CONTEXT_GUIDANCE}
For CLI self-analysis, [Discovery]/PIL output is supporting context. Use bounded usage_forensics / usage forensics snapshots; distinguish descriptions, character/token estimates and actual provider usage. Consumer cwd is not necessarily CLI source. No fixed per-round cost or credit-exhaustion inference from 429.
When respond_* is exposed, call it once with the complete final answer after investigation; otherwise answer directly.
[END NATIVE CAPABILITIES]`;

export const TASK_STAGE_GUIDANCE: Record<TaskStage, string> = {
  orient:
    "Identify the user's goal, known scope, constraints and next useful action. Answer a pure question directly. Use direct tools for known small tasks; research uncertainties. Load another stage only when its detailed guidance helps; preserve any required repository workflow.",
  research:
    "Collect bounded source/log/documentation evidence for the current question. Reuse sufficient current excerpts; retrieve elided evidence by exact toolCallId before rereading files. Use read_file ranges/max_chars for new details; refresh content when the edit guard requests it. Use literal grep without an LSP prelude; LSP for symbols/references/impact, assessing completeness. Query scoped recall before unfamiliar/risky steps. Preserve decisions, unresolved failures, file/line and session/toolCallId references in a short handoff, not raw logs. Main chooses useful independent delegation.",
  plan: "Record scope, decisions, affected files, protected boundaries and measurable acceptance. Resolve unknowns before editing. Follow the applicable repo workflow and plan-review requirements. A context stage is not an approved plan. Pass a short handoff with evidence references rather than copying the full investigation; no mandatory extra worker or council for a routine decision.",
  implement:
    "Read the exact code before editing; apply the smallest correct change within the assigned scope. Preserve unrelated user work and existing behavior outside the fix. Do not suppress failures or bypass approval/FLOW. Retain changed-file and proof references in the handoff; return to research/plan when evidence reopens scope. Main owns integration acceptance.",
  verify:
    "Run focused checks that prove the changed behavior and retain command/cwd/exit evidence. Default to verification_run for explicit local tests; select the runner when ambiguous. Use repo commands through bash for other workflows/builds without duplicate runs. UI/harness/workflow changes also need native selfverify status/result. Keep failed/skipped/unverified checks distinct; worker claims or TUI boot alone are not acceptance. Never push with failing required checks.",
};
