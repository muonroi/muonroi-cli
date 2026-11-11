# Revalidation decision parsing in session 4edc02516a92

## Confirmed consumer outcome

Read-only SQLite inspection confirmed session `4edc02516a92` tool message seq295, timestamp `2026-11-03T06:33:31.019Z`, toolCallId `call_8bd503c926de4f22b558786e`: native completion accepted verification job `clever-silver-badger`, resultVersion `3c26d939c7c9e5a9d31184fc6e2715cf66277e69174087784a58bf6a7973fca7`. Receipt fields are verdict=pass, verdictSource=structured, parseFailed=false, planVerified=true, phase=execute and canExecute.allowed=true. PLAN-VERIFY.md and STATE.md independently match that receipt; PLAN raw SHA remains `5dc7141141b1d8ea5860405ad8c7d83597e31571181fab732c85a011f7a76764`.

The two immediately preceding refusals are preserved: seq291 used the stale original council binding; seq293 returned `Unknown finding: CONCERN-2`. The final receipt uses actual dossier finding IDs and records main's evidence-backed assessment. These observations confirm live native planning admission, not TCIS implementation/build/test/server execution. They do not establish which file caused earlier source fingerprint differences. The parser defect explains missing parsed decisions; file mtimes alone do not prove the cause of byte-based source identity changes.

## Reproduced refusal

Read-only probes of the saved native jobs reproduced `plan_revalidation_refused: Independent verification needs a structured pass and unchanged host-bound evidence.` The refusal occurs before the final source-freshness comparison.

| Native verification job | Result version | Saved source unchanged | Native captures | Parsed host decision |
| --- | --- | --- | --- | --- |
| lively-amber-lynx | f463e933b7a8d0a7b3f2fba4034ddf3cd2a76d13a8724c2e9028a23eba6703ac | true | 14 | absent |
| quiet-indigo-falcon | 4b453957af00342667750307a061dc65af468957d3f350ed7a656ceb9c981db0 | true | 13 | absent |

The first verifier's `verification.md` starts with a short prose paragraph and ends with explicit pass/evidence JSON. The second is a fenced council-verdict containing approve, empty concerns, evidence and resolved findings. The ordinary independent-review parser accepts only whole-document pass/fail JSON, optionally fenced as JSON. Both raw decisions were consequently saved without `hostReview.verdict`. The saved output digests and appended native proof still match their records; no artifactError is present.

Two owned Flow integration tests reproduced these exact envelopes failing before the fix and passing afterward. This establishes a parsing defect; different fingerprints between two separate runs do not establish that either run changed its own source. `sourceUnchanged` compares each job's dispatch and completion snapshots, not different jobs.

## Repair and boundaries

- Plan revalidation now normalizes explicit structured decisions: canonical pass/fail, terminal JSON after a preamble, and council vocabulary with non-empty evidence and an explicit concerns array. Approve with concerns or an open blocking finding becomes fail; malformed or empty evidence does not become pass. This parses the verification decision only; it does not import a new council findings ledger.
- Older completed jobs can recover their explicit decision from manifest-checked `verification.md` without rewriting the saved record, resultVersion, appended native proof or immutable dossier. An existing explicit host-bound fail cannot be replaced by recovered approval. Historical `leader.md` is never the fallback decision.
- Verification output instructions come after the historical council and main's reason; the native contract explicitly says these materials do not replace pass/fail output instructions.
- Missing structured decision and explicit failure now have distinct errors. Ordinary implementation-review parsing is unchanged. Native capture/digest checks, failed-test vetoes, captured PLAN reads, final source/planning freshness, main adjudication and council allowance remain enforced.

The read-only saved-job probe passes the repaired evidence assertion for both jobs. At the time of that probe, their current planning digests still matched but their current source fingerprints did not. This repair does not turn either stale source snapshot into current approval. No historical file-level source manifest was available to identify the source difference; planning mtimes alone cannot identify it.

## Continuation in the consumer session

After loading the new CLI build in a fresh host, use native `flow_plan_review(action="revalidate")` against the original council `nimble-silver-fox`, resultVersion `17df2f30ef217dfd51a412623aa684a580f9f413d6f0b30033bf6c20825b26b3`, to obtain or reuse verification for the actual current snapshot. The reason should describe the parser repair and current evidence; it must not redefine the verifier output contract as council-verdict. Return only pass/fail JSON with concrete evidence.

Complete with the returned verification job's exact resultVersion, after reading its findings dossier and independently deciding each historical finding. Complete against the original council still binds old planning inputs. This is not a third council allowance: native revalidation is reserved per actual planning/source snapshot and unchanged inputs reuse an existing result. Never alter STATE, Git staging, saved records or dossiers merely to force freshness or reset an attempt.

## Validation

Evidence logs and the resumable run are under `.quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/`, run `runs/revalidation-verdict-contract.md`. No paid verifier, consumer gate completion, live restart, consumer build/test/pack, commit or push was performed.

155 distinct targeted tests passed across Flow admission, independent review, dossier packaging and council schema, including 14 new formatting/legacy/negative cases. Build/typecheck passed. The connected cached-npx selfverify tool failed to resolve its harness selector; the rebuilt workspace native MCP endpoint then passed smoke-boot 1/1 in run `6e8ac30f-8145-4684-a4a4-ffad60b14e29`. This verifies native startup only. Consumer Git index, PLAN, STATE, PLAN-VERIFY and PLAN-FINDINGS hashes stayed unchanged across the verification checks.
