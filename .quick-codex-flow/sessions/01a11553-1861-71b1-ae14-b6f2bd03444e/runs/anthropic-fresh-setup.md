# Fresh provider credential setup

Goal: Fresh users configuring the workspace-aware provider receive every required prompt before credentials are saved.
Workflow: qc-flow; auto continuation authorized by the coding request. Single agent.
Gate: complete; goal audit passed.

Evidence: TUI submitProviderKey only stores a key (use-app-logic.tsx:986); keys set only asks key (cli/keys.ts:115); config providers K only asks key (screen-providers.ts:147). Existing strategy reads persisted workspaceId and adds workspace header; SDK-wire tests reproduce missing-header HTTP 400. Official authentication docs require workspace header for unscoped keys; scoped keys omit it. Fresh boot remains chat with on-demand auth (harness/api-key.spec.ts).

Affected area: provider capability/setup helper, provider key dialog/keyboard/paste, interactive keys set and config providers K, focused tests and README.
Protected: OAuth selection repairs, existing user credentials/settings, other providers, unattended import/--api-key, catalog deployment, unrelated WIP. No real-key inference, no push or deployment required.
Gray areas: all resolved; explicit scope selection distinguishes scoped keys from workspace-required keys. Workspace-required is the default; invalid/empty ID cannot save. Cancel before save writes neither key nor workspace. Existing providers need only their API key.

Plan: (1) reproduce missing workspace prompt with mounted fresh-user test; (2) add shared capability-derived prompts/validation/persistence, wire TUI and both interactive CLI surfaces; (3) SDK-wire/unit tests and mounted scope/cancel/other-provider flows; (4) build/typecheck, native tier1 harness, docs and memory note.
Plan-check: each interactive entry uses the shared contract; persist settings before factory rewarm, preserve other settings, explicit scoped choice removes stale workspace, no new provider-ID branching. Existing fresh boot test retained. No active blockers.

Verification: bunx vitest -c vitest.harness.config.ts run tests/harness/anthropic-setup.spec.ts; focused provider setup + Anthropic SDK-wire tests; existing OAuth/picker/onboarding; bun run build; native selfverify tier1.
Resume: reproduce before production changes. Then execute waves sequentially and record measured results here.

Wave 1 evidence: fresh-setup-before.log missing scope dialog reproduced; direct Enter separately reproduced no key dialog (fresh-setup-enter-before.log). Added Enter setup for providers without OAuth and without credentials; successful Enter setup activates provider, K remains credentials-only. Plan-check extension passed: keep OAuth Enter behavior, move submit callback below setAsDefaultProvider to avoid TDZ, verify cancellation and both paths. Initial four mounted flows and 82 focused units passed; CLI subprocess 4 passed; first build exit0.

Verification extension: final 303 provider/CLI units pass (31files,16.20s);17 mounted tests pass (4files,32.07s), build exit0, native selfverify 571c8122-396f-4617-9a33-05d12ad68c57 boot1pass (provider-dialog opener skipped, covered by mounted tests). Compiled Node keys set probe found 3 cases with credentials saved but no process exit within45s; cancellation passed. Scope reopened then resolved: keys-set action awaits complete persistence but lacks command termination. Add explicit exit after stdout drain in that action only, bound subprocess exit assertion5s, rebuild and re-run source and compiled CLI tests. This is required for fresh setup command completion, no change to main/TUI lifecycle.

Final goal audit: Fresh unauthenticated Anthropic selection with Enter opens key -> explicit scope -> required workspace. Workspace input rejects blank/malformed values; K remains credentials-only. Escape/Ctrl+C before completion saves nothing. Shared prompt/persistence is used by keys set and config Providers K. Settings merge preserves endpoints and other providers; scoped choice clears stale workspace. Actual SDK transport proves configured header reaches the next request. Factory rewarm precedes activation. OAuth/main orchestration and unattended key import/flag flows preserved.

Final evidence:
- fresh-setup-before.log: missing scope prompt reproduced.
- fresh-setup-enter-before.log: Enter no-key provider did not open setup, reproduced.
- fresh-setup-unit-final.log:303pass/31files16.20s, includes 4 source CLI subprocess tests.
- fresh-setup-harness-final.log:17pass/4files32.07s, includes 4 fresh setup flows,6OAuth,4picker,3no-auth onboarding.
- fresh-setup-cli-final.log:4pass4.19s after explicit completion repair.
- fresh-setup-built-cli-final.log:4pass3.80s with Node and dist/src/index.js after completion repair; prior compiled run timed out3 cases after successful persistence.
- fresh-setup-build-final.log:build including tsc exit0.
- fresh-setup-selfverify-final.json:native selfverify run036fdf44-9cae-4bb7-9595-ad6176521eec boot1pass0fail; provider-dialog opener skipped, actual flow covered by mounted harness above.
- Scoped git diff check passes with cr-at-eol matching repository formatter. No compiled keys-set subprocesses left running.

Delivery: source and local dist updated. No commit, push, npm publication or catalog redeployment. Current user's credentials/settings were not edited. No real paid inference. Full unit suite not rerun for this local change; no push attempted. Native smoke alone is not full UI proof.
Resume: task complete; npm release is a separate delivery action.
