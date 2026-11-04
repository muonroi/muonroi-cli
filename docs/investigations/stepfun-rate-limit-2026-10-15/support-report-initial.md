# Step Plan HTTP 429 reproduction

Observed: 2026-10-15, approximately 01:29 UTC (08:29 UTC+7).

- Model: step-3.5-flash
- Endpoint: POST https://api.stepfun.ai/step_plan/v1/chat/completions
- Authentication: existing configured API key; omitted from this report
- Request: {"model":"step-3.5-flash","messages":[{"role":"user","content":"\nReply only OK."}],"max_tokens":64,"stream":false}
- Response: HTTP 429 in 800ms
- Error: {"message":"Rate limit reached, please try again later.","type":"rate_limited"}
- X-Trace-Id: f8be590705c2fa9da679ac23ca1887dc
- No Retry-After or quota/reset headers were returned.

This request was made directly with fetch, outside muonroi-cli and without a sub-agent or tool loop. No immediate repeated worker launch or concurrency load test followed.

The same key was accepted by documented GET /v1/accounts at 01:31:28 UTC (HTTP 200; X-Trace-Id b00c5253223cd80585174bb0f90fb760). This route exposes standard prepaid account balance, not subscription usage.

User reports Pro Plan, Active, valid until October 18, 2026; Plan Usage shows Credit usage Remaining 97%. Daily usage (Oct 14 to Oct 15): step-3.5-flash 35 calls / 0.54M Credit, step-5-preview 196 calls / 28.27M Credit. The displayed account request tier is V0: concurrency 5, RPM 100, TPM 500,000 for both models.

Further controlled observations, same key and Step Plan endpoint:
- Real CLI streaming call to step-3.5-flash at 01:34:12 UTC, max_tokens=2048, 3,148-byte request: HTTP 429 in 867ms. Trace ae93dfa5b430718c2d4b6b4c8e3a9e79. It failed before any worker was launched.
- Direct streaming call to step-5-preview at 01:35:53 UTC, prompt Reply only OK, max_tokens=64: HTTP 200 in 2,605ms. Trace 7efabd0434bfaffb041f42ed39a01543.
- Matching direct streaming call to step-3.5-flash at 01:36:24 UTC, same prompt/max_tokens=64: HTTP 429 in 840ms. Trace 81c961de5af69a97961c199e6b6cb1de.

The CLI's shared local ledger had no in-flight requests or active cooldown before this controlled run. This observation covers the local CLI, not all possible external clients using the account. No concurrency load test, new worker retry, model setting change or quota bypass was performed.

Please identify the exact restriction for the chat-completion trace: plan allowance/window, concurrency, model/account permission, or another serving limit, and its reset time if applicable.

References checked: https://platform.stepfun.ai/docs/en/step-plan/upgrade-notice and https://platform.stepfun.ai/docs/en/guides/developer/troubleshooting .

This report has not been sent to anyone.
