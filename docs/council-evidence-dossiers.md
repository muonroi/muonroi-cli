# Council evidence dossiers

A completed background council writes `<jobId>.review/` beside its durable job
record. The result includes the folder, SHA-256 manifest digest and exact file
selectors. Council advice does not update Flow state by itself.

```text
<jobId>.review/
  README.md                 Evidence boundaries and retrieval instructions
  leader.md                 Final synthesis, including the structured verdict
  findings.json             Stable IDs, blocking/advisory claims and closure
  participants.json         Actual model/role/persona trace and contributions
  inputs.json               Dispatched brief and host-owned plan input binding
  reproduction.md           Proposed checks; these have NOT been executed
  evidence/
    manifest.json           Native tool IDs, hashes, sizes and capture times
    <capture-digest>.json   Original arguments, output and model/phase provenance
  manifest.json             SHA-256 and byte sizes for all dossier files
```

Participant statements and leader agreement are model claims. The round archive
contains labeled excerpts, with original lengths; it is not a full transcript.
Only captured native tool outputs attest that a tool ran. A read or grep is
static evidence, not a passing test. Zero captures is reported explicitly.

Main reads the saved result, then retrieves dossier pages through the owning
session's native tool, for example:

```json
{"id":"<jobId>","toolCallId":"report:findings.json","resultVersion":"<exact version>","offset":0,"maxChars":16000}
```

Use the same selector form for participants, reproduction instructions and
captured evidence. Pages include total character length. Retrieve further pages
when needed. Files are allow-listed and hash-checked; arbitrary paths, changed
contents, foreign owners and stale versions are refused. Nothing in a dossier
is executed automatically.

Main inspects current plan references and the captured evidence. If a material
claim needs reproduction, main dispatches a bounded verification worker with
the exact source/plan and evidence references. Plan admission can accept an
observable preflight with stop-on-failure; implementation completion needs its
own executed verification.

A worker job reaching `complete` means its execution ended. Main still checks
which requested changes actually happened. The worker runner returns the final
SDK step's report, rather than treating earlier preparatory narration as its
answer. If that final report is absent it makes one tool-free synthesis request;
an empty/limited final is marked incomplete, and already executed tools are not
replayed. A report explicitly describing pending work is evidence of partial
scope completion, not acceptance of the whole assignment.

Worker requests and their final tool-free synthesis use the shared runtime
output-budget policy, including catalog reasoning ceilings and unsupported
parameter omission. Context checks reserve that effective output budget when
known. An output-limit error includes configured/effective limits and terminal
text length; it does not diagnose input-context overflow from file byte size.
Reading narrower ranges and keeping receipts concise can reduce the handoff,
but they do not replace checking the actual request budget.

For `flow_plan_review(action="complete")`, main supplies the exact job/version,
an independent `assessment`, and a `decisions` array. Each current or prior open
finding needs `findingId`, `decision`, nonempty `rationale`, and `evidence`:

| Decision | Meaning | Finding state |
|---|---|---|
| `accept` | Main confirms the reported gap remains | Open |
| `reject` | Main supplies counter-evidence to the claim | Closed |
| `resolved` | Main verifies the closure condition | Closed |
| `defer` | Evidence is insufficient to decide | Open |

Open blocking findings keep execution gated. Advisory findings do not. Main can
reject unsupported council blockers with evidence without paying for another
debate. Completion/notification/ACK alone never admits execution. Legacy saved
results still require per-finding decisions; missing dossiers or role traces
remain disclosed as missing, rather than reconstructed as observed evidence.

`PLAN-FINDINGS.json` retains current issue identities and main's evidence-backed
decisions. Review snapshots and `main-assessment.json` are archived under the
planning root's `reviews/<reviewId>/`. The next council receives this history.
Omission, a council-only resolution or an advisory downgrade cannot erase an
open blocker. A settled finding is retained as closed unless a reviewer gives
a reopening reason and new evidence; repeated assertions do not reopen it.

New host input bindings include the ledger. A changed plan, context or ledger
invalidates its pending review, including at the final write boundary. Older
bindings remain usable only while their original inputs match and no new
ledger has appeared. Review resource limits remain in force; exhaustion never
grants approval. Load a rebuilt CLI process to use the new protocol.

Resolve disputed material claims before spending the next review. The request
allowance limits new councils and plan rewrites; it does not limit read-only
verification or main's exact-result adjudication. A zero remaining allowance
does not require another council to validate main's `reject` or `resolved`
decision on unchanged review inputs. All owner/version/dossier/input checks and
per-finding evidence requirements still apply. A changed plan cannot reuse the
old result; do not reset the allowance or silently rebind it.

Assess a gate against its purpose. A real clean-corpus zero-count check is a
true-negative; lack of real secrets alone does not refute it when separate
seeded positive assertions exist. A negative sweep must cover the specified
roots and pattern families, and disclose failures or omitted scope. Worker
completion alone cannot turn a partial sweep or count discrepancy into proof.

## Changed plans after exhausted council allowance

`flow_plan_review(action="complete")` always refuses changed plan/context/ledger inputs. An old council's verdict is not approval of a revised plan. The three-council allowance is unchanged.

Main can instead request `flow_plan_review(action="revalidate", jobId, resultVersion, reason, planBody?)`. The source must be an owned, completed native council that main has read, including its findings dossier when present. `planBody` optionally supplies one concrete amendment. The host closes the gate, binds the current planning inputs and dispatches a separate read-only verify worker. The durable reservation covers the exact planning inputs plus host source fingerprint: unchanged completed work is reused and unchanged failed/cancelled work cannot be retried. A restart or a different reason does not replenish it. After a genuine amendment or source correction, a new verifier may inspect the new snapshot under the same original council. Running verification prevents overlapping amendments/dispatches. This does not spend or reset council allowance.

The fresh dossier retains the original council claims in `leader.md` and `findings.json`, labels them historical, and adds `verification.md`, the current input binding, original source result version, native read captures and host source fingerprint. It does not rewrite the original dossier or turn an empty legacy finding extraction into an approval.

Completion uses the **verification job's** exact ID/version. It requires a structured verification pass, a successful captured native read of current `PLAN.md`, unchanged source and planning inputs, an intact dossier read by main, and explicit evidence-backed main decisions for every open finding. Failed executed verification vetoes admission. A pass is static review unless runnable tests were actually executed. Main's `accept`/`defer` decisions preserve open blockers; `reject`/`resolved` need counter-evidence/closure evidence. `PLAN-VERIFY.md` and the immutable main assessment archive record this admission method and both result versions.

If verification fails, fix the evidenced plan/source gap and revalidate the revised inputs using the original council ID/version. Main must read and complete the new verification result; the old fail/pass cannot approve revised inputs. If no input correction is justified or evidence is unavailable, report the remaining gap. Do not reset the user request, relaunch unchanged work, launch another council outside allowance, or force the gate.
