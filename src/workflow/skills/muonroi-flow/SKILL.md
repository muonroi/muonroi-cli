---
name: muonroi-flow
description: Native Muonroi CLI workflow for discussing, planning, reviewing, executing, verifying, and delivering work with durable evidence and independent workers.
---

# Muonroi Flow

This workflow runs inside muonroi-cli. It needs no external workflow executable or shared skill installation.

Main owns user communication, planning, worker model selection, acceptance, and synthesis. Workers perform repository reads, edits, commands, tests, and independent review. Do not broaden main's tool access or let workers dispatch recursively.

1. Use `flow_status` to read the current cwd-owned plan and gate state. Reading status does not authorize changes.
2. For unresolved requirements, call `flow_discuss`. Resolve questions before planning.
3. Write the concrete plan with `flow_plan`, naming scope, evidence, boundaries, and verification. Use `flow_plan_review` when required by the active depth gate.
4. After the native gate accepts the plan, main dispatches bounded workers with explicit models; exchange progress through delegation messaging. Main does not need a repository execution tool. Worker launch does not approve its tools.
5. Read exact versioned worker results and host tool artifacts. Commission independent review of the target job using `reviewOf`; do not call a worker's conclusion proof of executed tests. Main acknowledges a handled result with its actual jobId and resultVersion.
6. Main accepts evidence actually obtained and produces a durable handoff. Missing evidence stays unverified. Host/infrastructure integrations may expose `flow_execute`, `flow_verify`, and `flow_ship` for phase transitions; call them only when they are in the current schema. Their absence does not authorize main to execute repository work. Publishing or pushing still requires the user's authorized scope and repository checks.

For informational requests and trivial read-only diagnostics, use the smallest applicable path; do not manufacture code-edit planning obligations. Use only tools actually present in the current schema. Permission mode, role limits, mutation gates, and custom tool consent remain independent boundaries.

State lives in the resolved `.muonroi-flow/planning` root (or explicit configured state root). Preserve existing plans and historical records. A failed review must never inherit an earlier passing verdict. Context compaction must retain bounded handoff summaries and exact artifact references.
