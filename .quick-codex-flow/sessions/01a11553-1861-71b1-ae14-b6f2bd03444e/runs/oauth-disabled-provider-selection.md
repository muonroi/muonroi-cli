# OAuth provider selection when disabled

## Resume digest / research and verified plan
- Goal: user reports successful OpenAI OAuth but provider remains X and cannot select. Restore explicit selection in TUI.
- Workflow qc-flow, auto authorized fix; single-agent. Preserve all prior repair/catalog/user WIP and live deployment.
- Evidence: real token file modified2026-10-08T10:12:52, access/refresh present, expires1792203188638 > now1791429254937. debug.log2369 records factory rebuilt2026-10-08T03:12:53Z. User settings disabledProviders includesopenai; default stepfun. No credential values logged.
- Code: picker mark combines hasKey and disabledProviders; Enter/D dispatch calls setAsDefaultProvider which immediately returns for disabled provider. OAuth handler's activateAfterLogin calls that guard unchanged. O authentication does not change enabled/default state.
- Plan: mounted regression with disabledProviders=['openai']; cover credentialless Enter completing OAuth and enabled selection, O remaining disabled until explicit Enter/D selection, already authenticated disabled selection. Preserve Escape behavior and unrelated disabled providers. Verify before/after via persisted settings and semantic selected state.
- Implementation boundary: use-app-logic explicit default selection enables chosen provider through existing setProviderDisabled; OAuth sign-in alone preserves selection. Picker clearly labels authenticated-but-disabled status, footer documents Enter/D select. No auth protocol/token/keychain changes.
- Verification: mounted regression reproducer, provider picker unit tests, build/typecheck, native selfverify, read-only credential/config diagnostics. No paid requests, no credential/settings edits unless needed for user recovery; existing user live session must restart built CLI.
- Wave1 active: reproduce disabled-provider selection; lock outcome against saved state before editing production. Plan-check passes: smallest generic fix, IDs derive selected provider; no routing/security state changed without explicit selection.

## Measured regression and fix
- getConfiguredProviders read-only runtime includesopenai; actualdisabledProviders includesopenai. OAuth succeeded and configuration eligibility is present; disabled state prevents selection.
- Mounted before:3fail/3pass. O followed by Enter and D time out on provider activation. Enter-disabled case also revealed test file-read EBUSY during writes; use semantic state completion before final settings assertion to prevent read races.
- Production fix: setAsDefaultProvider derives a model first, then setProviderDisabled(selectedProvider,false) and mirrors state before activating. O still leaves default/enabled choices intact until Enter/D. Picker labels authenticated disabled rows '(disabled · Enter to use)', footer Enter/D use.
- Mounted after:6pass0fail18.24s. Assertions include selected provider enabled/default model same provider, xai disabled unchanged, O no implicit activation, Escape no tokens.
- Anthropic follow-up: real user-settings providers.anthropic has no workspaceId. Official authentication docs require header for unscoped key. Read-only List Workspaces include_default=true using stored key returned403 'Missing permissions. Please check with Anthropic support if you think this is in error.' No paid inference made. User input question pending for workspace ID; never invent/choose an inaccessible workspace.
- Anthropic existing workspace strategy and real SDK wire tests will be verified again; actual account success requires the missing workspace ID.

## Final OpenAI acceptance / Anthropic pending input
- Final mounted suite:10pass0fail in2files20.69s (6OAuth/disabled selection +4model picker). Unit39pass0fail across3files, including10Anthropic SDK-wire tests.
- Build exit0 includes tsc; scoped diff-check exit0. Global Bun installation muonroi-cli is a junction to this repo and package bin=dist/src/index.js, so the next CLI launch uses the rebuilt code.
- OpenAI correction COMPLETE locally; restart running CLI then /providers -> OpenAI -> Enter. Existing stored OAuth token is valid; no re-auth needed for selection repair. User settings/credentials were not rewritten by our diagnosis.
- Anthropic actual-account correction awaits user's workspace ID. Header code already covered by actual SDK serialization tests; settings currently lacksID and automatic read-only discovery is denied403. User input question pending; do not claim live Anthropic success.
- Native selfverify result follows. No paid requests, no commits/push, unrelated WIP/live catalog unchanged.
- Native selfverify36b22b4c-dc53-4639-ae8c-6bc78aabf1da done:1passed/0failed, boot only. OpenAI acceptance closed; Anthropic remains waiting for required workspace ID.
