# Session 804115f7251f: review of the runtime feedback

Captured2026-10-17T07:40Z. Read-only inspection of the main/child transcripts and saved delegation records; no application source or settings changes for this review. Private bounded evidence: `.scratch/session-804-feedback/trace.json`.

## Verified observations and corrections

| Claim | Evidence and bounded conclusion |
| --- | --- |
| EE initially returned400 | Main seq5–6: query-only call b45010c1ca9db422 returned ee_project_required. Seq7–8: a35a40320c4852fc explicitly supplied D:/sources/Core/extension/ai-dock and received the same response. The second failure cannot be explained as simply forgetting project/cwd. The server could not resolve strict scope for that cwd. |
| EE recovered with an explicit target | Seq9–12: projects discovery followed by project=muonroi-cli returned two lessons and a native ee-context/v1 receipt. This proves the explicit recall path, not automatic resolution of AI Dock's project scope. Query text does not authorize cross-project recall. |
| Delegations completed | keen-teal-sparrow:07:22:29.212Z–07:22:43.493Z,14,281ms. quiet-emerald-wolf:07:21:43.144Z–07:22:44.835Z,61,691ms. These are recorded execution intervals, not time to first token or full parent callback latency. |
| Main consumed delegation output | Main seq15–16 read both saved results with matching jobId/resultVersion; saved deliveredVersion matches resultVersion for both. Neither record has acknowledgedVersion at this snapshot, and the transcript has no delegation_ack call. Read/delivery and explicit acknowledgement remain distinct. The earlier list's [pending] described delivery state before these reads. |
| Selfverify succeeded | Child run835a951c-f223-4d67-a7d5-ea08766c021c:1/1 smoke boot,1283ms. Main run94ca85ce-b9ff-468c-9caa-5d57be7265a1:1/1 smoke boot,1657ms. This is boot coverage, not extension-browser, delegation callback, or full CLI regression coverage. |
| Build/package/12 tests prove CLI correctness | These reported commands target the AI Dock consumer repository. Their passing results do not establish CLI orchestration correctness. Keep consumer validation separate from CLI validation. |
| 429 and council400 happened in this trial | The feedback cites delegation history and older recalled lessons. That is historical evidence; this report supplies no fresh rate-limit or council-error reproducer for the present turn. Do not call those current failures or infer a parameter-gating defect persists from a stored lesson. |
| A task worker must run foreground | Not established by this trial: it only launched delegate. Current source src/tools/registry.ts:1014–1018 explicitly describes task as background by default in interactive TUI and foreground by default for headless callers. Actual task behavior requires its own fresh runtime check. |
| Background research is read-only | This is delegate's intended capability boundary; task provides edit/execute work. Do not widen delegate permissions merely to remove the distinction. |

## What this review changes

- Keep the confirmed respond_general host-overlay repair in the separate incident report; this feedback predates that rebuild. It is not a fresh post-fix rerun.
- The observed EE friction is unresolved cwd-to-project scope, followed by successful explicit cross-repository targeting. Never select an unrelated known slug merely to obtain hits; specify muonroi-cli only when it is the intended recall target. Do not weaken strict filtering.
- The handoff is delivered but not acknowledged. Main should acknowledge each processed version explicitly; this reviewer did not acknowledge on its behalf.
- Tool counts, asynchronous delivery, read-only delegation and an advertised LSP stub do not independently prove failures. Prove any proposed behavior change against an explicit runtime contract.
- Improvements worth a bounded follow-up: clearer separate job/delivery/ack labels; actionable EE scope-resolution guidance without repeating the same rejected cwd. This review does not claim those changes have been implemented.
