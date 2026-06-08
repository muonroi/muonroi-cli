---
phase: 06-4-upgrades-security-perf-report-ui
plan: 01-security-hardening
type: execute
wave: 2
depends_on: ["Wave 0"]
files_modified:
  - src/utils/permission-mode.ts
  - src/tools/bash.ts
  - src/orchestrator/message-processor.ts
  - src/cli/usage-report.ts
  - tests/utils/permission-mode.test.ts
  - src/usage/decision-log.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "toolNeedsApproval only checks name (permission-mode.ts:34); no context (file path, command pattern)"
    - "Sandbox wrapCommandForShuru (bash.ts:598) exists but usage of secrets/allowNet is opt-in and not audited in logs"
    - "No persistent audit trail for 'approved in yolo' or high-risk bash"
    - "Keychain fallbacks (env > settings) not explicitly logged on first use"
  artifacts:
    - path: src/utils/permission-mode.ts
      provides: "Extended toolNeedsApproval(toolName, mode, context?) with command/path + dangerous pattern block"
    - path: src/tools/bash.ts
      provides: "shuru sandbox always logs effective settings + redacted command to decision-log"
    - path: src/usage/decision-log.ts
      provides: "New permission/audit events appendable from PermissionMode and bash"
    - path: tests/utils/permission-mode.test.ts
      provides: "Unit tests for context-aware approval + dangerous pattern flagging"
  key_links:
    - from: src/utils/permission-mode.ts (lines 32-34)
      to: toolNeedsApproval logic
      via: "add context param + onApproval hook or decision-log append"
      pattern: "permission-mode.ts:34"
    - from: src/tools/bash.ts (line 598)
      to: wrapCommandForShuru
      via: "always log when sandboxMode==='shuru'"
      pattern: "bash.ts:598"
---

<objectives>
Reduce blast radius of yolo/permission modes, improve secret hygiene, add auditability for privileged operations.

Purpose: Every high-risk action (yolo bash, file rm, network in safe) leaves an auditable trail in existing decision-log/cost-log. toolNeedsApproval gains context so safe mode can block dangerous patterns without full yolo.
Output: 
- Extended PermissionMode + audit hook
- bash.ts shuru logging
- New `usage security-audit` (or security subcommand) reusing usage-report infra
- Unit tests + smoke
- Docs updates in AGENTS.md / CLAUDE.md
</objectives>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md
@src/utils/permission-mode.ts (full, esp. 1-38)
@src/tools/bash.ts (wrapCommandForShuru at 598, execute path)
@src/orchestrator/message-processor.ts (approval gate ~2328)
@src/cli/usage-report.ts (reuse aggregate/printTable for new security-audit)
@src/usage/decision-log.ts (if exists; else create minimal append)
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend PermissionMode with context + audit hook + dangerous pattern blocking</name>
  <files>src/utils/permission-mode.ts, src/usage/decision-log.ts, tests/utils/permission-mode.test.ts</files>
  <read_first>
    - src/utils/permission-mode.ts (lines 1-38 — current PermissionMode enum + toolNeedsApproval)
    - .planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md (Security section lines 25-53 for exact gaps/steps)
    - src/orchestrator/message-processor.ts (approval call site ~2328)
  </read_first>
  <behavior>
    - toolNeedsApproval now accepts optional context: { command?: string; path?: string; isNetwork?: boolean }
    - In safe mode: if command matches dangerous regex (rm -rf /, curl|wget to external, chmod 777 etc.) → return true (require approval) or throw with clear message
    - Add appendAudit(event: { kind: 'permission' | 'yolo-override'; tool: string; mode: string; context?: any; ts: number }) that writes to decision-log (reuse existing append format)
    - New unit tests:
      - safe mode + "rm -rf /tmp/foo" → requires approval
      - yolo mode + dangerous cmd → allowed but audit event written
      - context with path for file ops (e.g. write outside project) flags in safe
    - No behavior change for existing calls that pass only (toolName, mode)
  </behavior>
  <verification>
    - `bunx vitest run tests/utils/permission-mode.test.ts` — all new tests green
    - Manual: node -e 'require("./dist/utils/permission-mode").toolNeedsApproval("bash", "safe", {command: "rm -rf /"})' → true
  </verification>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Instrument bash shuru + message-processor approval to always emit audit events</name>
  <files>src/tools/bash.ts, src/orchestrator/message-processor.ts</files>
  <read_first>
    - src/tools/bash.ts (wrapCommandForShuru:598 and execute function)
    - src/orchestrator/message-processor.ts (tool approval gate and sandboxMode usage)
  </read_first>
  <behavior>
    - When sandboxMode === "shuru": before/after wrap, append to decision-log: {kind:'sandbox-shuru', cmd: redacted(cmd), effectiveSettings: {...}, ts}
    - On every approval decision in message-processor (even auto in yolo): call the new audit append from permission-mode
    - Redaction: strip obvious secrets (key=..., token=..., AWS_*, etc.) before logging
    - Existing truncateOutput / cost controls untouched
  </behavior>
  <verification>
    - Smoke: MUONROI_TEST_NO_KEYCHAIN=1 bun run src/index.ts --permission-mode yolo -p "run: rm -rf /tmp/test-audit" --max-tool-rounds 1 ; then `usage forensics <session>` or direct grep decision-log for the event
    - Assert audit entry contains redacted cmd + mode + ts
  </verification>
</task>

<task type="auto">
  <name>Task 3: Add `usage security-audit --since 7d` (reuse usage-report infra)</name>
  <files>src/cli/usage-report.ts, src/cli/index.ts (command wiring)</files>
  <read_first>
    - src/cli/usage-report.ts (lines 200-274: runUsageReport, aggregate by callsite/role, printTable, agent-self snapshot)
    - src/cli/index.ts (where "usage" subcommands are registered)
  </read_first>
  <behavior>
    - New subcommand or flag: `usage security-audit --since 7d --json`
    - Reuses existing log parsing (decision-log + cost-log + new permission events)
    - Output: table or json of yolo sessions, high-risk cmds executed, approval overrides, keychain fallback uses
    - `--format md|json` support (consistent with existing report)
  </behavior>
  <verification>
    - `bun run src/index.ts usage security-audit --since 1h --json | jq length` > 0 after a yolo smoke
    - tsc clean; no regression on `usage report --by role`
  </verification>
</task>

<task type="doc">
  <name>Task 4: Update docs (AGENTS.md, CLAUDE.md) + add threat model note for permission modes</name>
  <files>AGENTS.md, CLAUDE.md</files>
  <read_first>
    - AGENTS.md (Zero Hardcode, Evidence-First, sandbox/permission mentions)
    - CLAUDE.md (harness + permission related notes)
  </read_first>
  <behavior>
    - Add short "Permission Mode Threat Model" section: safe=block dangerous by default + audit; yolo=full power + mandatory audit trail; recommend audit review before production use.
    - Reference the new `usage security-audit` command.
    - Update any "sandbox off = full host power" notes to mention audit is now always-on for shuru/yolo.
  </behavior>
  <verification>
    - grep -A5 "Permission Mode Threat Model" AGENTS.md
    - No broken links or outdated examples in the permission sections
  </verification>
</task>

</tasks>

<verification_gate>
- Full: `bunx tsc --noEmit && bunx vitest run` (focus permission + sandbox tests)
- Harness (if UI surface added): `bunx vitest -c vitest.harness.config.ts run tests/harness/`
- Smoke: yolo + dangerous cmd → audit appears in logs; `usage security-audit` surfaces it
- Pre-push: also run `bun run src/index.ts self-verify --since HEAD~1 --max 2` if any TUI touched (none expected here)
- This sub-PLAN updated with actual commit + SUMMARY after land
</verification_gate>
