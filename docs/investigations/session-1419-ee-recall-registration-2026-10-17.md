# Session1419c612a6b7: EE client.recall scope400 and TUI noise

## Confirmed cause

The helper `eb4dc060ae0e` called native ee_query `chatcmpl-tool-bdf885d96886490f`. Its recorded result was `[ee_project_required]` with HTTP400 and cwd `D:/sources/Core/extension/ai-dock`. EE health returned200. This was an unresolved project registration, not an observed429 or transport outage.

SSH inspection verified the active user service `experience-engine.service`, deployed repository `/home/phila/experience-engine`, clean develop commit `2187ba68b681a86a956b782859baa05908a9d221`. Its `org.repoPatterns` contained nine exact repository names, including muonroi-cli but excluding ai-dock. The deployed `deriveCallerMeta` returned null for the AI Dock cwd and muonroi-cli for the CLI cwd. `lib/path-canonical.js` intentionally uses this explicit registry rather than inventing a project from arbitrary path basenames.

The local original EE checkout is older and contains unrelated WIP; it was preserved. Deployed-source comparison and tests used the clean strict-project worktree, not that older checkout.

## Repair

### EE deployment configuration

At2026-10-17T07:53:20Z, appended only the actual `ai-dock` repository registration to the server's existing repoPatterns. Preserved every other JSON value, verified again after restarting the same user service. No EE algorithm patch or broad fallback was required; server source hashes and installed commit are unchanged.

- Backup: `/home/phila/.experience/config.json.backup-2026-10-17T07-53-20-189Z`, mode0600.
- Mutation guarded against concurrent registry changes; Windows cwd canonicalization and unknown-path rejection checked before writing. Backup and atomic replacement were used, with rollback if reload failed.
- Service active after reload, PID1444131. Config preservation check at07:54:33Z confirmed that only the registration changed, installed commit2187ba68b681 unchanged.
- No credentials or collection schemas were changed; no lessons were created or edited. Normal recall can record surface/activity metrics. Config/credential values were not printed.

### CLI diagnostics

`src/utils/ee-logger.ts` now writes EE diagnostics through `logger.file`, preserving error name/message and bounded HTTP/body/timing metadata without raw stderr noise. `src/ee/client.ts` forwards the already recognized `projectRequired` flag.

Only a recognized `client.recall` error with status400 and projectRequired=true omits the generic ee-error event that becomes `EE error: client.recall` in the TUI. The native tool still returns actionable scope guidance; the failure is retained in the file log. Generic400, auth401/403, rate429, server500, network and timeout errors retain their respective runtime events. HTTP errors also carry status metadata. Event-delivery failure is recorded to file instead of silently swallowed.

## Live measurements

Configured native tools used the CLI's normal URL/token resolution; no hardcoded unauthenticated curl was used. Lesson text and tokens are omitted from evidence.

| Cwd / check | Before | After |
| --- | --- | --- |
| AI Dock, query-only strict recall | HTTP400,91ms, no project proof | HTTP200,9939ms, strict/project-only ai-dock proof,0 entries; native context binds ai-dock |
| muonroi-cli, query-only strict recall | HTTP200,10108ms, strict CLI proof,1 entry | HTTP200,7429ms, strict CLI proof,2 entries |
| Unknown synthetic cwd | Explicit fail-closed source test | HTTP400,41ms, no proof or task binding |
| Native health | Session health200 | All three target checks health200; reachability remains separate from recall readiness |
| Runtime error events after repair | Scope400 previously emitted generic error |0 in the three-call live probe, including recognized unknown-cwd scope400 |

These are individual observations, not a controlled latency or recall-relevance benchmark. Successful recall still took approximately7.4–9.9s in this probe. Changing registration fixes scope recognition, not server recall performance. Zero AI Dock entries is a valid empty scoped result, not downtime.

## Verification

- Seven new diagnostic regressions failed before the CLI repair.
- CLI focused tests:69 passed in6 files; covers file-only logging, scope400 event suppression, preserved HTTP auth/rate/server events, timeout behavior, native scope and strict proof. Build exit0, scoped diff check exit0.
- EE existing source tests:21 passed,0 failed, for canonical path handling and strict project filtering, including foreign/global/conflicting/malformed scope rejection and protected graph expansion.
- Rebuilt offline/native/MCP/TUI controls:16/16; native selfverify2/2, run `f3136984-ed98-4e5f-bf4d-3e7615319447`.
- Fresh live native after-probe exit0. The initial Node24/Windows before-probe saved its HTTP observations and JSON, then hit a UV_HANDLE_CLOSING assertion during forced shutdown. The after-probe used natural shutdown and exited0. This is a probe shutdown limit, not evidence EE crashed.
- No full CLI suite, paid model-generation trial or git push performed. No user CLI processes were killed. EE registration is already live; restart the CLI with Bun to load its local diagnostic changes.

Report evidence: `docs/investigations/evidence/session-1419-ee-recall-registration-2026-10-17.json`; private bounded probes under `.scratch/ee-cwd-scope/`.
