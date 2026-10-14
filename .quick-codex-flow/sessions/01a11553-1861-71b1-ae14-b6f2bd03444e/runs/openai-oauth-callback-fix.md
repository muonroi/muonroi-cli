# OpenAI OAuth callback completion

## Resume Digest
- Goal: fix OpenAI sign-in that shows browser authorization success but does not authenticate the CLI.
- Gate: done. Execution: auto, user explicitly requested the repair.
- Evidence: user screenshot localhost:1455/auth/callback displays the exact SUCCESS_HTML from src/mcp/oauth-callback.ts. Do not copy authorization code from the screenshot.
- Affected surface: callback server, OpenAI OAuth login, browser token exchange, token store, UI sign-in handler; exact production edit boundary not yet locked.
- Protected: actual credentials, existing OAuth protocol/client configuration unless verified necessary, other provider flows, all prior repairs and user WIP.
- Unknowns: resolved by local runtime evidence; no callback failure in this run.
- Rejected hypothesis for this run: post-callback token exchange blocked. Local token file exists, contains access/refresh/account ID (values withheld), modified 2026-10-08 09:23:25. Debug log 2026-10-08T02:23:25.460Z confirms openai factory rebuilt. This is after token persistence in the actual UI login handler.
- User settings still defaultProvider=anthropic/defaultModel=claude-sonnet-5; preceding model-call failures explicitly provider=anthropic. Authentication and selection are separate in current behavior.
- Evidence: use-app-logic.tsx Enter branch says use-this-provider, calls setAsDefaultProvider only when already authenticated; the unauthenticated OAuth branch calls login without a selection continuation. startProviderOAuth ends with refreshProvidersWithKey and modal closure, no success message or model activation.
- Protected protocol: do not change client ID, scopes, callback URI, token exchange, or unrelated timeout behavior; no evidence these caused this user's complaint.
- Plan: real mounted TUI regression using a test-only entry with real callback server and local token endpoint; Enter must save tokens and activate catalog-selected OpenAI model; O must save tokens without changing selection; cancel/failure must preserve previous selection. Then implement activation continuation and explicit success feedback, verify mounted paths + focused UI/provider tests + build/native selfverify.
- Plan-check: continuation uses existing setAsDefaultProvider/cached catalog; no new provider/model literals. Login-only O remains distinct. All fixtures use isolated homes/fake credentials and local servers. Preserve prior WIP in use-app-logic.tsx.
- Next verify: mounted OAuth sign-in/selection regression before production edits.
- No push, no external messages, no paid model calls, no subagents.

## Before-repair proof
- Mounted TUI with actual callback server and local token HTTP endpoint: Enter persisted OAuth tokens and closed the sign-in card but failed the default-provider activation assertion. O-only login passed. openai-oauth-selection-before.log: 1 failed / 1 passed, 7.95s.
- Initial fixture navigation waited for semantic sequence changes, but provider navigation only changes paint styling; corrected the test to yield to React between keys before establishing product evidence. Those initial fixture failures are not product findings.
- P1/W1 locked edit: continue Enter/D selection via existing setAsDefaultProvider after successful login; O-only remains login-only; add success toast. Capture the attempt controller so cancelled/stale sign-ins cannot apply the new activation side effect or overwrite a newer sign-in card.

## Final changes and verification
- Moved startProviderOAuth below its existing setAsDefaultProvider dependency; activateAfterLogin defaults false. Enter/D on an unauthenticated OAuth row passes true; O keeps false.
- After token persistence/factory refresh/picker refresh, successful Enter uses the existing catalog-derived activation path. UI shows Signed in plus active model; O shows successful sign-in and the instruction to select a model.
- Each attempt retains its own AbortController; aborted attempts do not activate a model or update a newer sign-in's error card. Non-cancelled errors log context and message.
- Local callback/token endpoint mounted test before repair: Enter failed activation while O passed. After repair final mounted run: 3 passed / 0 failed, including Enter, O, Escape cancellation and visible success-toast assertions (openai-oauth-mounted-final.log, 8.59s). Model selection is checked against the actual catalog's provider.
- Mounted wallet startup plus OAuth prior pass: 4 passed / 0 failed (openai-oauth-mounted.log). Test-only bootstrap exposes local transports; production OAuth protocol remained unchanged.
- Focused unit regressions: 90 passed / 0 failed in 10 files, 10.70s (openai-oauth-unit.log). Covers provider auth/token store, factory rewarm, picker focus/visibility, Anthropic wire headers.
- Final build including TypeScript compiler: exit 0 (openai-oauth-build.log). git diff --check clean for changed surfaces.
- Native selfverify tier1 after build: run 9f721556-bfcb-4361-b6ac-28c27b7d3792, 1 passed / 0 failed / 0 inconclusive (openai-oauth-selfverify.json). This is boot-only evidence, separate from the mounted OAuth flow proof.
- No real OAuth login/model request triggered by these tests; real user token values were never printed or modified. No full-suite rerun, commit, or push. Existing user settings remain Anthropic until the user selects OpenAI.
- Delivery: restart rebuilt CLI; /providers -> OpenAI -> Enter. Existing stored OAuth credentials can be reused. Anthropic repair is also complete; configure providers.anthropic.workspaceId with the actual Console workspace ID if retaining its unscoped key.
