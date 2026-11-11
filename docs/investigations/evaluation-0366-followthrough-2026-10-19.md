# Runtime evaluation follow-through: 0366c5a9d7b3

## Scope and preserved evidence

Reviewed `D:/sources/Core/extension/ai-dock/MUONROI-CLI-EVALUATION.md` as UTF-8 and inspected the exact session's job metadata and interaction rows read-only. The original report remains unchanged: SHA256 `336b6d1ddd19e5524c446c91dde88f466a49864ef8592a305cc9d467f8a80398`. No user report, planning artifact, credential, job, ACK, acceptance or historical ledger entry was rewritten. Existing unrelated working-tree changes were preserved.

## Repairs and improvements

| Area | Verified finding | Change |
|---|---|---|
| Required worker MCP | All three failing jobs explicitly granted docs_search/docs_read. Child assembly used the normal2500ms cold-connect deadline, despite an existing critical-server wait in the pool. A local SDK wiring fixture failed before the fix. | Derive critical server IDs from exact granted tool names and configured normalized prefixes; reuse the existing bounded critical wait. Optional integrations and role/grant restrictions remain separate. Missing required tools still stop before the model; diagnostics use the actual wait and do not promise a detached worker another turn. |
| Bare usage | Fresh old-build subprocess returned exit1 and group help. | `usage` now shows the same help with exit0; its existing subcommands remain. |
| Feature discovery | /ideal and /council have actual in-session handlers; root positional words are initial prompt text, not named command discovery. | Root help advertises these surfaces; `features`, `features ideal`, `features council` explain actual entry points without starting models/workers. Unknown feature arguments are refused. No executable ideal/council top-level subcommand is fabricated. |
| Doctor | The original checks omitted recorded MCP/PIL failures. | New `integrations.runtime` check reads bounded24h observations, statuses, counts and last timestamps. It distinguishes history from a live readiness probe and does not expose raw response bodies or change credentials. |
| Flow recovery | A revise verdict is a legitimate closed gate. Machine-readable JSON already exists in flow_status; STATE.md is not that API. | Structured review state adds concerns, truncation flag, artifact path, attempt ID, recorded cycle, parse/source fields and nextAction. flow_plan_review returns this state and gates. Reading status does not write or unlock state. No automatic retry/cycle budget or pass is invented. |
| Review telemetry | Generic tool_call/result rows do not identify the resolved council leader/duration. | Existing flow-native records now include resolved leader and measured duration in queryable columns, verdict, concern count, attempt ID and artifact references. A failed attempt records duration/error/requested-model boundary; it does not claim an executed leader. |
| PIL timeout observability | Six session-window observations say pipeline-timeout without identifying the failing phase or elapsed work. They cannot establish a network/model/backend cause. | New failures retain fallbackPhase and fallbackDurationMs through schema/context, read_pil_context, journal and doctor. Existing deadlines, cancellation and optional background/nonblocking behavior remain. No speculative timeout increase or provider retry was added. |
| Cost interpretation | The report combines historical global cost/product ledgers and compares research input with an initial topic/context estimate. | usage report states its date/run/source scope, estimated-cost basis, lack of provider-invoice deduplication for combined ledgers and limits of the drift ratio. Historical data is retained. |

## Corrections to the evaluation

- DB rows63506 and63782 are successful `flow_plan_review` tool results. The claim that no such result exists is contradicted by the exact session data.
- The three MCP jobs all contain the same two explicit grants; the described no-grant control was not actually no-grant in persisted metadata.
- `steady-copper-heron` is a completed council job in this session, without reviewOf. Historical reviewOf records and missing acceptance are not council verdict quality measurements. Council advice does not become accepted implementation evidence.
- `$31.0786 / $106.6935` is **29.13%**, not28.7%. These historical ledger estimates are not a provider invoice or session-only spending measurement.
- `chat-export-985b3540cc14.txt` exists at the ai-dock workspace root. Not finding it inside the planning directory alone does not establish a missing reference. Cross-session job references still need explicit provenance; CLI code was not used to rewrite the user's plan citations.

## Fresh verification

| Check | Result / boundary |
|---|---|
| Related regression | **199 tests /18files**, exit0; includes MCP delayed readiness, grants/permission/message boundaries, doctor, Flow verdict/gates/telemetry, PIL deadlines/cancellation/nonblocking main stream and cost forensics |
| Built Bun CLI | **8/8 checks**,7 subprocesses: usage0, feature discovery/help, invalid feature1, cost scope warnings |
| Built native Flow tools + loop host + private SQLite | **8/8 checks** with local scripted perspective callbacks: revise concerns/current attempt ID, closed gate, read-only status, model/duration/verdict/artifact telemetry |
| Actual configured cold MCP initialize/tool inventory | muonroi-docs **1146ms**, all6 advertised tools including both required names,0errors. This did not execute docs_search/docs_read or call a model; it is not a tool-content or future-latency guarantee. |
| Native selfverify / actual Bun TUI | Boot **1/1** passed |
| Build / typecheck | Exit0 |

Logs, private numeric incident snapshot and control scripts: `.scratch/evaluation-0366/`. Public numeric manifest: `docs/investigations/evidence/evaluation-0366-followthrough-2026-10-19.json`. Tests use private HOME/USERPROFILE, CLI/auth/env paths and NODE_ENV=test; native Flow asserts its actual SQLite path. No paid provider/council replay, full suite, push or deployment was performed. A disk build does not prove the already-running user process loaded it; restart with Bun against the new dist path.

## Remaining integration limits / bounded follow-up

- StealthGPT's recorded401 invalid_token/No authorization provided requires valid server authorization/sign-in. No credential was supplied for that service, and none was copied, invented, rotated or silently disabled. The doctor warning now makes the recorded failure visible.
- Historical PIL timeout rows do not contain phase/timing, so this work does not claim to repair a proven backend fault. On a fresh timeout after restart, obtain the exact session ID, read_pil_context fallbackReason/fallbackPhase/fallbackDurationMs, and the matching integration_status row/cwd/time. This closes the missing observation without rerunning a broad audit or sharing prompts/keys.
- The observed startup~1s was not a specified performance failure. No speculative startup rewrite or altered model routing was introduced.

Copy-ready follow-up for the runtime session:

> Sau khi khởi động bản mới bằng Bun, kiểm tra `read_pil_context`. Nếu có `pipeline-timeout`, chỉ gửi sessionId, fallbackPhase, fallbackDurationMs và dòng `integration_status` cùng cwd/thời điểm. Phân biệt lỗi optional PIL với EE recall và MCP auth; không suy ra server down/quota từ timeout, không gửi API key hay toàn bộ prompt. Với MCP bắt buộc, ghi jobId, tool grant thực tế và lỗi initialize nếu còn; không tự fan-out/retry nhiều worker.
