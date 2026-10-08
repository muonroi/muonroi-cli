# Anthropic workspace authentication

## Resume Digest
- Goal: resolve the reported non-workspace-scoped Anthropic API key rejection.
- Gate: done.
- Mode: auto, continuing the user's authorized local repair scope.
- Scope: Anthropic strategy, provider settings type, SDK wire regression tests, README.
- Protected: existing keys, other provider authentication, all previous watchdog/PIL and user WIP changes. No push or paid API requests.
- Gray areas: none after reading the factory, strategy, settings reader, and provider setup screen.
- Required outcomes: configured workspace ID reaches the Messages API for sync/async factories; existing scoped keys need no ID; caller headers remain supported.

## Evidence and resolved decisions
- Official authentication docs https://platform.claude.com/docs/en/manage-claude/authentication lines 113-154 require anthropic-workspace-id on every request for unscoped keys. Console Settings -> Workspaces exposes the ID.
- src/providers/strategies/anthropic.strategy.ts:19 passes only apiKey/baseURL to the SDK, ignoring CreateFactoryOpts.headers.
- src/utils/settings.ts ProviderKeyConfig has only apiKey/baseURL; loadUserSettings reads JSON without dropping additional fields.
- src/providers/runtime.ts routes sync and async callers through this strategy, including council/compaction/bootstrap factories.
- src/cli/config/screen-providers.ts saves keys without a live workspace validation probe. No separate Anthropic setup request needs patching.
- Legacy Adapter has no production callers per src/providers/index.ts; leave that deprecated boundary out of scope.
- EE recall returned unrelated provider cross-wiring evidence; do not use it as evidence for workspace authentication.

## Plan and plan-check
1. Add a failing wire test using the real installed SDK and a fake HTTP transport returning the reported workspace rejection. Capture missing headers before changing production code.
2. Add optional providers.anthropic.workspaceId, trim it, and pass it in SDK headers. Keep explicit caller header precedence. No workspace guessing, default ID, or new auth mode.
3. Document the configuration and scoped-key alternative. Run focused provider/settings regressions, typecheck/build, native boot QA for provider startup compatibility.
- Plan-check: strategy is the shared production construction seam; reads settings using this.id without introducing a provider/model ID literal. Optional field retains existing key behavior. Stubbed transport proves actual SDK requests without credentials or paid calls.
- P1/W1: regression proof -> repair -> focused tests -> build -> boot QA. Sequential execution; no delegated work.
- Next verify: bunx vitest run src/providers/__tests__/anthropic-workspace.test.ts.
- Context risk: bounded; retain this artifact and exact results; earlier acceptance run remains complete.
- Stall: none. Approval: existing authorization; no external mutations.

## W1 proof
- Before repair: real SDK wire tests reproduced HTTP 400 with the reported message. 4 failed / 4 passed; configured ID, async factory, explicit headers, and whitespace-trim tests failed because the SDK request contained no workspace header.
- Evidence: anthropic-workspace-before.log. This is a stubbed HTTP transport with actual SDK serialization/error parsing, not an Anthropic account test.
- Repair: optional workspaceId; strategy builds standard Headers, fills only an absent workspace header, preserving case-insensitive caller overrides. No authentication behavior added to other providers.

## Final verification
- Provider/settings suite: 522 passed / 0 failed, 51 files, 24.15s. Includes 9 actual SDK wire tests covering streaming and generation; anthropic-workspace-tests.log.
- First typecheck caught a union type with Ollama's baseURL-only configuration. Narrowed the existing Anthropic strategy ID using satisfies ProviderId; final bun run build passed (tsc included), anthropic-workspace-build.log.
- Native selfverify tier1: run 5b8bc952-2b48-4612-af16-fddccb64aefc, 1 passed / 0 failed / 0 inconclusive. Boot-only compatibility evidence; anthropic-workspace-selfverify.json.
- No live Anthropic request, no key/settings mutation, no full-suite rerun or push. Configure the actual workspace ID and restart the rebuilt CLI before live authentication.
- User steered the next task to OpenAI OAuth after browser callback success. Anthropic repair is complete locally; next run owns OAuth investigation.
