# Seven-day report and session watchdog audit

## Requirement Baseline
- Goal: verify the user's seven-day report and diagnose the plan-request watchdog in session cde402aafc74.
- Outcomes: measured report corrections; exact session timeline; evidence-based repair preparation.
- Inputs: scripts/analyze-7d.js, local SQLite database and logs, current source.
- Baseline HEAD: 54e2a8c2ab9de3b8f93b7c5604b48e90b55ef264.
- Protected boundaries: existing staged/unstaged work; credentials; live database; no production changes or push in this audit.
- Scope: read-only data/source investigation and audit artifacts.
- Execution mode: manual; requested investigation proceeds to a concrete reviewable result.

## Workflow State
- Current gate: done (audit deliverable only)
- Current phase / wave: P2 / W1 verified
- Next transition: open a research-gated repair run; no implementation is authorized by this audit artifact.
- Delegation: none; sequential single-agent investigation.

## Gray Area Register
| ID | Question | Resolution | Status |
|---|---|---|---|
| G1 | What are the exact seven-day counts and token semantics? | snapshot.json and AUDIT.md | resolved |
| G2 | Where did the supplied session stop? | Error 53459 and breadcrumb 515: pilPrep | resolved to phase |
| G3 | Which log errors are current and which are historical? | AUDIT.md dated log corrections | resolved |
| G4 | Which internal PIL await stalled and does abort settle it? | Future P0/W1 layer-level trace and fault injection | deferred to repair research |

## Resume Digest
- Goal: audit report and session cde402aafc74 watchdog.
- Current gate: done for audit; P2/W1 verified.
- Remaining blockers: none for audit; G4 remains a repair-research gate.
- Risks: mutable runtime data; dirty worktree; avoid conflating estimates and billed usage.
- Experience constraints: recall returned unrelated entries; verify source and runtime data directly.
- Next verify: P0/W1 internal-await and cancellation evidence, then plan-check.
- Recommended next command: Use $qc-flow and resume from this run to open P0/W1 in AUDIT.md; close G4 before locking production edits.

## Research Pack
- `node scripts/analyze-7d.js` fails: require is not defined in ES module scope; package.json has type=module.
- crash.log ReferenceError STDERR_TAIL_CHARS is dated 2026-09-24, outside the requested seven-day window; current source declares the constant.
- debug.log:2339 records idle watchdog at 2026-10-07T07:46:02.334Z, linked by SQL to parent session cde402aafc74.
- Completed findings and repair preparation: AUDIT.md. Single-transaction snapshot: snapshot.json.
- SQL links watchdog to parent session: interaction_logs id 53459, lastPhase=pilPrep.
- Runtime probes passed in Node and Bun: interactive classification can outlive pipeline budget; no provider calls were made.
- Source, build artifact hashes, current runtime PID/entry path captured in AUDIT.md.

## Delivery Roadmap
| Phase | Status | Outcome | Verification |
|---|---|---|---|
| P1/W1 | verified | Correct report and trace supplied watchdog | Read-only SQL, timestamp-filtered logs, fault-injected built runtime |
| P2/W1 | verified | Reviewable repair preparation with unresolved leaf called out | Each proposed wave traces to measured evidence and verification gates |

## Plan Check
- Audit scope and protected boundaries met; artifacts contain exact window and evidence IDs.
- Production repair is not execution-ready: G4 must close before locking a fix.
- No tests/build/harness/push claimed; only local audit probes passed.

## Compact-Safe Summary
- Scope is audit only; preserve all user WIP and database contents.
- Next verify: future P0/W1 automated-wait and cancellation trace.
- Phase relation: relock-before-next-phase; action: research before locking a repair.
- Keep: session ID, HEAD, frozen window, relevant event IDs.
- Forget: unrelated recall results and broad output.

## Wave Handoff
- Source completed audit; next target research-gated P0/W1 in AUDIT.md.
- Carry-forward invariants: no production edits; read-only DB; timestamp bounded findings.
- Resume payload: Use $qc-flow and resume from this run for session cde402aafc74.
