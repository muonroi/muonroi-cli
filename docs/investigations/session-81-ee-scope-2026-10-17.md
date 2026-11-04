# Session81: EE recall scope refusal misreported as unavailable

## Finding

The consumer session `81e606ae4fda` runs in `D:/sources/Core/extension/ai-dock`. Its stored native `ee_query` calls at seq60 (`chatcmpl-tool-8e66208d0c28b292`) and seq75 (`chatcmpl-tool-86e9b999c0f113f9`) omit the `project` argument. A project name inside the query text does not populate the request's `project_slug`.

A fresh native trace reproduces the failure condition: the configured remote EE receives `strict_project=true` plus the consumer cwd, cannot resolve a concrete project for that cwd, and returns HTTP400:

> Cannot resolve a concrete project for strict recall; pass project_slug from /api/projects

The client previously converted every non-2xx recall into null. The native tool then called that `ee_unavailable`, with a generic server-down/timeout/circuit explanation. That diagnostic concealed a real HTTP scope rejection. The historical session has no saved transport status for those particular calls; the current live reproduction, matching omitted project argument/cwd and client path, supplies the status evidence.

## Live measurements

Official native tools were instantiated from the local compiled CLI. URL and authentication came from the existing CLI resolver. No hardcoded-token request, config mutation or server restart was used. Saved traces omit auth headers/tokens and raw recalled lessons.

| Native operation | Before repair, 04:07:43-04:08:02 UTC | After rebuild, 04:15:52-04:16:11 UTC |
| --- | --- | --- |
| Configured `/health` | HTTP200,77ms | HTTP200,80ms |
| Recall from ai-dock, no explicit project | HTTP400,28ms; tool says `ee_unavailable` | HTTP400,29ms; tool says `ee_project_required`, unavailable=false |
| Recall from ai-dock, explicit muonroi-cli | HTTP200,9645ms | HTTP200,8855ms |
| Recall from CLI cwd, explicit muonroi-cli | HTTP200,8666ms | HTTP200,8352ms |

Both explicit-project cases returned `strict=true`, `project=muonroi-cli`, `policy=project-only` and matching caller cwd. Both returned **zero entries for the chosen query**; this demonstrates successful scoped recall transport/proof, not useful lesson coverage. Timing differences are separate snapshots, not a latency improvement experiment.

The server is reachable and strict rejection is working. This does not establish availability for all future requests. A health200 is still only reachability, not recall readiness.

## Repair

- `EERecallOptions.onHttpError` is an optional request-local diagnostic observer. Low-level `EEClient.recall()` retains its existing null-on-failure contract. The observer is not sent over HTTP; concurrent requests share no last-error variable.
- HTTP failures log status and a bounded, redacted JSON error body. Reflected configured auth tokens are explicitly removed.
- `recallEE` reports the known unresolved-project HTTP400 as `[ee_project_required]`, with guidance to pass the exact `project` argument. Other HTTP failures become `[ee_request_rejected]` with status. Network failures remain unavailable.
- The formatter preserves these diagnostic messages instead of replacing them with a misleading zero-entry recall footer. Rejections contain no lessons and return before mirroring/injection.
- Existing successful-response strict proof validation remains unchanged. No automatic cross-project retry, guessed project slug, broader recall, disabled strict filtering or server mapping change was introduced.

## Verification and limits

- Seven initial RED tests reproduced missing HTTP diagnostics/observer and formatter behavior.
- Accepted suite: **42 passed,0 failed,6 files** (`recall-http-diagnostic`, `recall-scope`, `client-failure-logging`, `client`, `health-contract`, native `registry-ee-query`), exit0. Includes concurrent rejection/network separation,400/401/403/429/500/503, non-JSON failure body, token redaction and one-request strict native behavior.
- Build exit0; post-build native live controls reproduced the before/after diagnostic with strict proof preserved.
- Source changes are confined to EE client/types/shared recall formatting and the native tool description. Existing dirty work was preserved. No DB migration, settings change, server deployment, full-suite run, push or publication.
- No UI/harness or workflow-authority changes were made. This diagnostic follow-up did not repeat TUI selfverify; the earlier silent-final report retains its separately identified TUI run.
- This verifies newly started local compiled modules. It does not establish which modules an already running consumer CLI process loaded.

Artifacts/scripts: `.scratch/session-81-ee-recall/{db-ee.py,db-ee.json,trace.mjs,trace.json,trace-after.json,red.log,tests.log,build.log}`. Adjacent evidence JSON includes source/compiled hashes and these measurements.

## Consumer-session follow-up

For the current task inspecting muonroi-cli from another workspace, invoke the native tool with a real argument:

```text
ee_query({"project":"muonroi-cli","query":"session 81e606ae4fda final answer recovery"})
```

Use the correct known project slug for other tasks. Do not put `project=...` only inside query text, change global endpoints, disable strict scope or infer that an empty result is a transport failure. The diagnostic change requires loading the new build; explicit-project recall works with the existing server.
