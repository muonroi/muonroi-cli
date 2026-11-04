# Document review and host-evidence display: session 985b3540cc14

## Corrected diagnosis

The accept gate already supports independent static workspace inspection. Executable tests are not required for every deliverable. A local Markdown fixture, read by the production file tool and reviewed through the production delegation manager, was accepted with `reviewLevel=static` before and after this change.

Read-only historical metadata establishes two different refusals:

- `steady-indigo-badger`: `sourceUnchanged=true`, successful inspection, but no parsed `hostReview.verdict`. This does not establish a structured pass.
- `nimble-copper-lynx`: parsed `pass`, `sourceUnchanged=true`, successful read/grep plus an unsuccessful `verification_run`. The test runner rejects the supplied Markdown target; the gate refuses any review carrying unsuccessful test-run evidence.

The claim that Markdown acceptance is structurally impossible is contradicted by the fixture. The published native tool description incorrectly required “host test evidence,” steering the coordinator toward the wrong runner. The gate's generic error hid the distinct reasons. EE hint `cb96b973` was rated ignored after checking it; no historical lesson, acceptance, ACK, report or job record was rewritten.

## Changes

1. Main tool and worker review guidance distinguish static document content inspection, bound runtime artifacts, and executed test evidence. `verification_run` explicitly accepts runnable tests, not reports. Review output must be the required JSON alone. It is still invalid to infer passed tests from a static review.
2. Refusals identify `review_verdict_required`, `review_snapshot_required`, `review_binding_mismatch`, `review_evidence_required` or `failed_verification_evidence`. Owner/version/delivery/source checks remain. An unsuccessful runner remains a veto; this change never turns that existing review into a pass.
3. A validated delegation read emits a SHA256 reference for its exact trailing host-review evidence. The display projection hides only that matched internal footer. Worker prose, JSON verdict and quoted headings remain verbatim. Unknown, unbound legacy or tampered blocks remain visible. No raw worker text, saved artifact, model transcript or export is rewritten. Existing unbound historical tool cards require a fresh read to obtain the new display reference.

## Fresh evidence

| Check | Result |
|---|---|
| Regression suite: static/real-test/artifact acceptance, refusal/tamper/owner boundaries, worker tools/prompts, dispatch, UI projection and approvals | 166 tests / 12 files, exit 0 |
| Built UI plus actual native OpenTUI frames at 120 and 64 columns, raw control, historical read-only artifact projection | 12/12 checks, exit 0 |
| Build / typecheck | Exit 0 |
| Native tools-MCP selfverify using actual Bun TUI | Boot 1/1 passed |

Before-fix regressions failed on the exposed footer and generic failed-runner refusal (2 failures / 63 passes). The Markdown static acceptance case already passed, proving the diagnostic correction rather than weakening the gate.

The native raw-control frame visibly contains `HOST_INTERNAL_JSON_SENTINEL`; projected normal/narrow frames show `WORKER_VISIBLE_EVIDENCE` and omit the host JSON. The historical `nimble-copper-lynx` artifact matches its saved SHA256 result version. A synthetic read envelope in the new format projects 18,693 saved characters to 5,745 display characters while preserving the worker's pass verdict. Both saved output and job JSON were checked byte-for-byte unchanged. This proves display projection, not acceptance of that historical result or adoption by the user's already-running process.

Private logs/frames: `.scratch/review-document-display-985b/`. Numeric manifest: `docs/investigations/evidence/review-document-display-985b-2026-10-18.json`.

These are local fixtures, production native tools/manager and renderer checks. No paid provider/worker replay, complete export reconciliation, full suite, push or deployment was performed. Test HOME/USERPROFILE/CLI/auth/env paths were isolated. Existing CLI processes need a Bun restart to load the new build.
