# Permission mode threat model

> Moved out of `AGENTS.md` (2026-11-06): it is documentation of host-enforced behavior, not a per-call
> instruction. Line references re-checked against the code on 2026-11-06; the original text's stale
> references are listed at the end.

- `safe`: every tool call (bash, file, computer, etc.) requires explicit user approval before execution
  (`toolNeedsApproval`, `src/utils/permission-mode.ts:163`, safe branch at `:209-211`).
- `auto-edit`: read/write/edit/grep/list_directory auto-approve (`AUTO_EDIT_ALLOWED`). `bash` and
  `run_gate` auto-approve **unless** the command matches a dangerous pattern (rm -rf /, external
  curl/wget, chmod 777, eval/exec, `chown root`, …) — then approval is forced
  (`permission-mode.ts:201-207`). Other tools outside the allow-list still require confirmation.
- `yolo`: all tools auto-approve (full power, no prompts). A dangerous command still emits a
  `yolo-override` audit entry with the tool context to the decision log (`permission-mode.ts:189-199`
  → `appendAudit`, `:222`, which calls `appendDecisionLog`; event kinds declared in
  `src/usage/decision-log.ts:29-31`).
- Catastrophic commands are blocked at the tool layer in every mode, including yolo
  (`checkCatastrophicCommand`, `permission-mode.ts:143`, called from `BashTool.prepareCommand`,
  `src/tools/bash.ts:807`). Escape hatch: `MUONROI_ALLOW_CATASTROPHIC=1`.
- Audit is always-on for privileged paths: `usage security-audit --since 7d --json` (or 1h/30m)
  surfaces yolo sessions, high-risk cmds (secrets redacted), approval overrides, shuru executions, and
  other taken decisions (`src/cli/usage-report.ts:338`). Review
  `~/.muonroi-cli/usage/decision-log-*.jsonl` before production use.
- shuru sandbox: verify-recipe runs can use `sandboxMode = "shuru"` (`src/verify/entrypoint.ts:129`).
- Recommendation: treat yolo as "audit-then-trust"; never use on untrusted or high-stakes prompts.
- Plan of record: `.planning/phases/06-4-upgrades-security-perf-report-ui/01-security-hardening-PLAN.md`
  (Task 4, lines 134-150 at the time of writing).

## Corrections made when this moved out of AGENTS.md

| Old claim | Current code |
|---|---|
| auto-edit: "bash + computer tools still require confirmation" | non-dangerous `bash`/`run_gate` auto-approve (`permission-mode.ts:202-206`) |
| `appendAudit (permission-mode.ts:83)` | `appendAudit` is at `permission-mode.ts:222` |
| `bash.ts:567 prepareCommand` | `prepareCommand` is at `bash.ts:807` |
| `src/utils/permission-mode.ts:36 (toolNeedsApproval)` | `toolNeedsApproval` is at `permission-mode.ts:163` |
| `src/tools/bash.ts:598 (wrapCommandForShuru)`, shuru degrade at `bash.ts:489`, "every shuru sandbox wrap emits yolo-override/permission-override" | no `wrapCommandForShuru` and no `shuru` reference in `src/tools/` (grep, 2026-11-06). Where per-command shuru wrapping + its audit now live is **unverified** — check before relying on it |
| plan at `01-security-hardening-PLAN.md:134-150` (repo root) | file is under `.planning/phases/06-4-upgrades-security-perf-report-ui/` |
