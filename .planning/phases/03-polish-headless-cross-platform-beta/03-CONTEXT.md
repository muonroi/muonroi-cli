# Phase 3: Polish, Headless, Cross-Platform Beta - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** Auto-generated (infrastructure phase — discuss skipped)

<domain>
## Phase Boundary

The CLI passes headless / MCP / LSP smoke tests, runs on Windows 10, Windows 11, macOS, and Linux via CI matrix, ships standalone binaries with three permission modes, and has the operator surface (`doctor`, `bug-report`, issue templates, STATUS.md) needed for solo-maintainer beta support.

**In scope:** CORE-01..07, OPS-01..04.
**Out of scope:** CLOUD/BILL/WEB (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Use ROADMAP phase goal, success criteria, and codebase conventions to guide decisions.

Key constraints from PROJECT.md:
- Solo maintainer — every feature must be defendable as one-person ops.
- Must run on Windows 10, Windows 11, macOS, Linux without major divergence.
- Bun runtime; `bun build --compile` for standalone binaries.
- 3 permission modes: `safe` (confirm every tool), `auto-edit` (auto-approve reads+edits, confirm bash), `yolo` (auto-approve all).
- Sub-agent/delegate system from grok-cli preserved unchanged (CORE-04).

</decisions>

<code_context>
## Existing Code Insights

Codebase context will be gathered during plan-phase research.

</code_context>

<specifics>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to ROADMAP phase description and success criteria.

</specifics>

<deferred>
## Deferred Ideas

None — infrastructure phase.

</deferred>
