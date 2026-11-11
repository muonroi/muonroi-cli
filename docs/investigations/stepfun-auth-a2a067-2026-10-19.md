# StepFun API key with a saved plan endpoint

Session: `a2a067c7ca78`. Investigation date: 2026-10-19 local time.

## Confirmed incident

- Read-only SQLite `interaction_logs` records 63917 and 63925, at 2026-10-18T17:10:27.172Z and 17:11:21.279Z: HTTP400 from `api.stepfun.ai`, body `{"error":{"message":"you have no active step plan subscription","type":"request_params_invalid"}}`.
- Routing records63913/63921 selected the provider flagship `step-5-preview`. Responses contained no completed tools/text.
- At inspection, user settings still selected `providers.stepfun.baseURL=https://api.stepfun.ai/step_plan/v1`. A StepFun key entry exists in the CLI env store; no credential value was printed or changed. Presence does not establish API model entitlement or credit.
- Historical diagnostics recorded host/body, not the full request path. The configured endpoint and local SDK reproduction establish the route-selection defect; this report does not invent a missing HTTP capture.

## Reproduction and repair

The actual SDK adapter received the recorded status/type/message from a local fetch fixture. Before repair, five assertions failed: sync factory, async factory, stream fallback, host-selected API mode, and propagation of the API leg's own error. Five negative controls passed. `before.log` preserves this clean reproducer run; an earlier harness assertion typo was corrected before that run.

1. The canonical endpoint registry now identifies the existing subscription route and its exact measured entitlement error. Default API URL remains unchanged.
2. Factories using that recognized route plus an actual API key reuse the existing bounded subscription fallback. Subscription remains primary; an eligible pre-output failure permits one request to the same provider/model through its standard API endpoint, retaining the output budget. The selected API mode is latched for the factory and passed to children.
3. A separate Agent reproducer showed that the synchronous provider helper discarded a host-selected API mode, recreating the saved plan endpoint. `worker-before.log` records the observed wrong URL. The helper now forwards the existing mode at both construction sites.
4. Ordinary RPM/TPM429, unrelated400, cancellation, network failure, partial output, missing real keys and arbitrary proxy endpoints do not authorize a new billing route. An API rejection is returned rather than replayed indefinitely. Rewarming a factory resets its latch; saved endpoint settings are preserved.

## Fresh verification

| Check | Result | Artifact |
|---|---|---|
| Focused provider/auth/worker regressions | 126 tests, 15 files, exit0 | `.scratch/stepfun-auth-a2a067/tests.log` |
| Typecheck | exit0 | `typecheck.log` |
| Build | exit0 | `build.log` |
| Built SDK/Agent fixture | 8/8 checks | `compiled-probe.json` |
| Native tools-MCP selfverify, actual Bun TUI boot | 1/1 | `native-selfverify.json` |

Artifacts are under `.scratch/stepfun-auth-a2a067/`; bounded incident snapshot: `incident.json`. Tests/probes isolated HOME, USERPROFILE, CLI home, auth directory and env file, with NODE_ENV=test. The compiled probe checks its SQLite path stays inside the fixture home and its settings remain byte-identical.

The built fixture proves subscription-first, exactly one API fallback, same key/model/budget, returned API content, selected API mode, Agent worker bypassing the saved plan route, unchanged fixture settings and private DB path. It uses scripted HTTP responses, not real provider billing or a paid worker run. The native boot check establishes startup only.

## Operational boundary

Restart the CLI once to load the rebuilt code, using Bun for the interactive OpenTUI entrypoint. No real provider request was sent with the user's key during this investigation; whether the API account permits the selected model remains a live provider check. Existing credentials, saved billing endpoint, sessions and jobs were not rewritten. No push or deployment.
