---
phase: 06-4-upgrades-security-perf-report-ui
plan: 03-ui
type: execute
wave: 1
depends_on: ["Wave 0"]
files_modified:
  - src/ui/status-bar/status-bar.tsx
  - src/ui/app.tsx
  - src/ui/components/code-block-truncate.ts
  - src/orchestrator/orchestrator.ts
  - src/agent-harness/semantic.tsx
  - tests/harness/ui-status.spec.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "Rich components: council-phase-timeline, product-status-card, agents-modal, mcp-modal, status-bar (src/ui/)"
    - "Semantic wrapping for agent-harness (self-verify works)"
    - "Code-block-truncate.ts already exists"
  artifacts:
    - path: src/ui/status-bar/status-bar.tsx
      provides: "permissionMode + sandboxMode + compaction % display"
    - path: src/ui/components/code-block-truncate.ts
      provides: "Clickable 'view full (bash-42)' hint with run_id"
    - path: tests/harness/ui-status.spec.ts
      provides: "Harness spec for new status indicators + truncation UX"
  key_links:
    - from: src/ui/app.tsx
      to: status bar and modals
      via: "add permission/sandbox state from orchestrator"
      pattern: "status-bar"
---

<objectives>
Make TUI more transparent about security/perf state and reduce visual noise for long sessions.

Purpose: Surface permissionMode/sandboxMode and compaction savings in status bar. Improve truncation UX so agents/users can retrieve full output without losing middle content. Use semantic ids for harness coverage.
Output: 
- Status bar shows permission/sandbox + compaction %
- Truncation shows "view full (run_id)" hint
- Clearer yolo risk prompts
- Auto-collapse for long sessions
- New harness spec
</objectives>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md
@src/ui/status-bar/status-bar.tsx
@src/ui/app.tsx
@src/ui/components/code-block-truncate.ts
@src/orchestrator/orchestrator.ts (stats exposure)
@src/agent-harness/semantic.tsx
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Update status bar to show permissionMode, sandboxMode, compaction savings</name>
  <files>src/ui/status-bar/status-bar.tsx, src/ui/app.tsx, src/orchestrator/orchestrator.ts</files>
  <read_first>
    - src/ui/status-bar/status-bar.tsx (current render)
    - .planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md (UI section lines 108-120)
    - src/orchestrator/orchestrator.ts (compaction stats, permission state)
  </read_first>
  <behavior>
    - Status bar always displays: [perm: safe] [sandbox: off] [comp: -23%]
    - Pull permission/sandbox from context or settings
    - Pull last compaction savings % from orchestrator (expose if not)
    - Use <Semantic id="status-perm" ...> for harness
  </behavior>
  <verification>
    - `bunx vitest -c vitest.harness.config.ts run tests/harness/`
    - Self-verify: `bun run src/index.ts self-verify --since HEAD --max 2`
    - Visual smoke in TUI
  </verification>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Enhance truncation UX + permission prompt + long-session polish</name>
  <files>src/ui/components/code-block-truncate.ts, src/ui/modals/ (permission), src/ui/log-view.tsx</files>
  <read_first>
    - src/ui/components/code-block-truncate.ts
    - src/ui/app.tsx (permission cards)
  </read_first>
  <behavior>
    - On truncate: append "view full (bash-42)" that triggers bash_output_get or copies id
    - Permission prompt: "yolo mode — risk: high (shell)" with one-line summary
    - Long session: auto-collapse old council phases/tool results (user pref)
    - Add semantic ids to new elements
  </behavior>
  <verification>
    - New harness spec: tests/harness/ui-status.spec.ts
    - `bun run src/index.ts self-verify`
    - Truncate smoke: large bash output shows actionable hint
  </verification>
</task>

</tasks>

<verification_gate>
- Full: `bunx tsc --noEmit && bunx vitest run`
- Harness + self-verify (Tier 1)
- TUI smoke for status + truncation
- This sub-PLAN updated post-land
</verification_gate>
