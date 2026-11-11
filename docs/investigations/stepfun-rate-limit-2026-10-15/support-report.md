# Step Plan intermittent HTTP 429 — sanitized reproduction

Observed October 15, 2026, approximately 01:29–01:52 UTC. Client: muonroi-cli source workspace 1.9.0, Bun 1.3.13, AI SDK 6.0.169 / OpenAI-compatible provider 2.0.42. Same configured credential throughout; key intentionally omitted.

Endpoint: POST https://api.stepfun.ai/step_plan/v1/chat/completions

User dashboard reports Pro Active through October 18 and 97% Credits remaining. Standard /v1/accounts returned 200 with the same key; its balance is separate from Step Plan allowance.

A bounded serial matrix and wire-control sample made 16 requests with output cap 64, no retries, one at a time, ten-second gaps. step-5-preview: 4/4 HTTP 200. step-3.5-flash: four HTTP 200 and eight HTTP 429 out of 12. These are sample counts, not an account-wide failure-rate estimate. Requests were made directly and through the SDK, outside CLI pacing and worker execution.

The following same model/body/visible application-header pair demonstrates mixed acceptance:

```json
{"model":"step-3.5-flash","max_tokens":64,"messages":[{"role":"user","content":"Reply only OK."}],"stream":true}
```

Headers other than Authorization: Content-Type application/json; User-Agent ai-sdk/openai-compatible/2.0.42 ai-sdk/provider-utils/4.0.24 runtime/bun/1.3.13.

- 01:46:24.265 UTC: HTTP 429, trace 16a365b6a853794e33cf2a66abd21a16, 924 ms to headers.
- 01:46:35.198 UTC: HTTP 200, trace c5f1277333db037f6e4ab33a844717a9, 1,691 ms to headers.
- 01:47:14.042 UTC: HTTP 429, trace b780076eb3355481b90bb14772d5cea9.
- 01:47:24.329 UTC: HTTP 429, trace 620b0b9032b5ceec921ad29afe06691a.

429 body: {"error":{"message":"Rate limit reached, please try again later.","type":"rate_limited"}}. No Retry-After, quota dimension or reset header was exposed in these results.

Please identify the actual server-side rejection dimension and its scope/reset for these trace IDs, including whether the published Step Plan Credit policy applies to this subscription. We have separately identified CLI cancellation/cooldown issues that amplify waiting; they do not account for these direct HTTP refusals. Activity on other clients/devices using the account was not ruled out.

This draft has not been sent to StepFun or anyone else.
