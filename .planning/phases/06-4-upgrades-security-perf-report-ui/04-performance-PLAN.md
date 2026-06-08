---
phase: 06-4-upgrades-security-perf-report-ui
plan: 04-performance
type: execute
wave: 3
depends_on: ["Wave 0", "Wave 1"]
files_modified:
  - src/tools/registry.ts
  - src/tools/bash-output-cache.ts
  - src/tools/bash.ts
  - src/orchestrator/subagent-compactor.ts
  - src/orchestrator/compaction.ts
  - src/orchestrator/orchestrator.ts
  - src/ui/status-bar/status-bar.tsx
  - src/ui/app.tsx
  - .env.example
autonomous: true
requirements: []
must_haves:
  truths:
    - "Excellent: sub-agent + top-level compaction (subagent-compactor.ts:297, compaction.ts:1440), bash cache + `bash_output_get` (registry.ts:255), 32k cap + truncate (registry.ts:106), read-path-budget"
    - "Gaps surfaced in prior work: `bash_output_get` result still goes through `truncateOutput` (registry.ts:290); cache LRU only 50; no 'expand stub' for compacted tool results; dynamic cap not context-aware; UI re-renders on every frame even for static status"
  artifacts:
    - path: src/tools/registry.ts
      provides: "bash_output_get bypass truncate for mode=full; dynamic cap 128k for vitest/tsc/git log; expose MUONROI_COMPACTION_PREVIEW_CHARS"
    - path: src/tools/bash-output-cache.ts
      provides: "LRU max 200 entries + size-based eviction"
    - path: src/orchestrator/subagent-compactor.ts
      provides: "expand-tool-result helper + exposed compaction preview chars"
    - path: src/ui/status-bar/status-bar.tsx
      provides: "React.memo for static status; compaction % from orchestrator"
  key_links:
    - from: src/orchestrator/subagent-compactor.ts (line 297)
      to: rewriteOlderToolMessage
      via: "add expand helper for toolCallId"
      pattern: "subagent-compactor.ts:297"
    - from: src/tools/registry.ts (line 290)
      to: truncateOutput + bash_output_get
      via: "bypass for full mode"
      pattern: "registry.ts:290"
    - from: src/tools/registry.ts (line 106)
      to: DEFAULT_MAX_TOOL_OUTPUT_CHARS=32_000
      via: "context-aware dynamic cap"
      pattern: "registry.ts:106"
---

<objectives>
Keep token costs flat and latency low for 100+ turn sessions; reduce unnecessary re-exec / re-read.

Purpose: Build on existing compaction (B3/B4), 32k caps, bash cache. Remove friction from truncation losing middle content; allow agent to expand stubs; make caps dynamic; reduce UI re-renders; expose hidden consts as env.
Output: 
- bash_output_get mode=full bypasses truncate
- bash-output-cache LRU=200 + size eviction
- expand-tool-result for compacted results
- Dynamic caps (128k for build cmds)
- UI memo + self-verify timing
- MUONROI_COMPACTION_PREVIEW_CHARS env
- Cost-leak harness + long-session smoke pass
</objectives>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md
@src/tools/registry.ts (lines 106,255,290)
@src/tools/bash-output-cache.ts
@src/tools/bash.ts
@src/orchestrator/subagent-compactor.ts (297)
@src/orchestrator/compaction.ts (1440)
@src/orchestrator/orchestrator.ts
@src/ui/status-bar/status-bar.tsx
@src/ui/app.tsx
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: bash_output_get full bypass + increase cache LRU + size eviction</name>
  <files>src/tools/registry.ts, src/tools/bash-output-cache.ts, src/tools/bash.ts</files>
  <read_first>
    - src/tools/registry.ts (106,255,290 for cap, get, truncate)
    - .planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md (Performance section lines 54-80)
    - src/tools/bash-output-cache.ts (current LRU=50)
  </read_first>
  <behavior>
    - In bash_output_get: if mode=full, return full cached without truncateOutput call
    - Or add maxChars override passed through
    - bash-output-cache: maxEntries=200 (env MUONROI_BASH_CACHE_MAX), size-based eviction (drop oldest > avg size)
    - Update truncate hint to note full retrieval path
  </behavior>
  <verification>
    - Live smoke: 100k+ char output; bash_output_get full returns >32k no truncate
    - `bunx vitest run` (cache tests)
  </verification>
</task>

<task type="auto" tdd="true">
  <name>Task 2: expand-tool-result helper + dynamic cap in registry + expose preview chars</name>
  <files>src/orchestrator/subagent-compactor.ts, src/tools/registry.ts, src/orchestrator/compaction.ts</files>
  <read_first>
    - src/orchestrator/subagent-compactor.ts (297 rewrite)
    - src/tools/registry.ts (cap logic)
    - src/orchestrator/compaction.ts (1440)
  </read_first>
  <behavior>
    - Add expand-tool-result (toolCallId, keepLast=3) that rewrites stub back to full from cache or re-run minimal
    - In registry: if cmd matches (vitest|tsc|git log|bun test), use 128k cap
    - Expose MUONROI_COMPACTION_PREVIEW_CHARS (default 80k sub, 200k top) from subagent-compactor.ts
    - Update orchestrator to pass env to compactor
  </behavior>
  <verification>
    - Cost-leak harness: `bunx vitest -c vitest.harness.config.ts run tests/harness/cost-leak-*.spec.ts`
    - Agent can request expand and get full middle content
    - Before/after usage report shows lower avg chars
  </verification>
</task>

<task type="auto">
  <name>Task 3: UI perf memo + status re-render + self-verify measure + docs</name>
  <files>src/ui/status-bar/status-bar.tsx, src/ui/app.tsx, .env.example</files>
  <read_first>
    - src/ui/status-bar/status-bar.tsx
    - src/ui/app.tsx (re-render paths)
  </read_first>
  <behavior>
    - Wrap status/log with React.memo / OpenTUI equivalent; skip if no perm/sandbox/compaction change
    - Add timing in self-verify for status re-render
    - .env.example: document MUONROI_COMPACTION_PREVIEW_CHARS, MUONROI_BASH_CACHE_MAX
    - Measure: self-verify reports re-render count delta
  </behavior>
  <verification>
    - `bun run src/index.ts self-verify --since HEAD --max 2`
    - tsc + full test
    - Long session smoke: 100+ turns, token flat, UI responsive
  </verification>
</task>

</tasks>

<verification_gate>
- Full: `bunx tsc --noEmit && bunx vitest run`
- Harness cost-leak + self-verify
- Live: 100k bash full retrieve; usage report lower avg
- This sub-PLAN updated with actual commit + SUMMARY after land
</verification_gate>
