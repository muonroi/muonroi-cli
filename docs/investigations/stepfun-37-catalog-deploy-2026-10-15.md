# StepFun 3.7+ catalog deployment — 2026-10-15

The owner requested retiring Step 3.5 and redeploying both the canonical catalog JSON and its FastAPI service. Catalog 2.21 is deployed and healthy. Authenticated internal and public responses contain 49 models and exclude `step-3.5-flash` and `step-3.5-flash-2603`.

| StepFun route | Selected model |
|---|---|
| fast / auxiliary calls | step-3.7-flash |
| balanced | step-3.7-flash |
| premium / large-model work | step-5-preview |

The 3.7 row is balanced with `routing_tiers: ["fast"]`; Step 5 Preview remains premium. Existing pricing, context, output limits, rate limits, specialty audio/image rows and unrelated providers/policies are preserved. This is an owner-requested support policy, not a claim that the vendor discontinued 3.5. Model availability was cross-checked against the [StepFun platform](https://platform.stepfun.ai/); the moderator guidance itself was supplied by the owner.

Three explicit local 3.5 pins were migrated to 3.7: the user's default model, this CLI project's model, and the Shipd project's worker model. Existing Step 5 main/leader settings remain. Backups are retained in `C:/Users/phila/.muonroi-cli/settings-backups/20261015-stepfun37/` and beside the user's settings file. Historical sessions/messages were preserved. Explicitly requesting a retired model now fails catalog resolution; no alias silently redirects it.

## Deployment proof

- Canonical source: `src/models/catalog.json`, version 2.21, updated 2026-10-15. SHA256: `8da0d150384a8e8d2f248698998ec348adb37bf0055fccaa8b5009fee27fcb09`.
- FastAPI already reads the canonical JSON; its existing main.py/schema is correct. All four build inputs were transferred with hash checks, and the image was rebuilt/recreated with the updated JSON. No duplicate model list was introduced.
- Target: `phila@100.79.164.25`, `/opt/muonroi/docker-compose.yml` plus its existing override, service `catalog`, published at `127.0.0.1:8086`.
- New image: `sha256:3d487709d03067ebbe45e14dd4be666ec814987da8a939a338dd8a6d032cd320`; health: healthy. Container JSON and main.py hashes match the transferred source.
- Internal and public `/api/v1/models`: authenticated HTTP 200, 49 models, exact source IDs/order, version/date and all non-price fields checked. Live price overlays remain enabled. Both `/health` endpoints returned HTTP 200.
- The actual rebuilt CLI client fetched `https://catalog.muonroi.com/api/v1/models` once with authentication, received HTTP 200, consumed version 2.21/49 models, excluded both retired IDs and selected all three routes shown above. This verifies live consumption rather than static fallback.
- All 13 other running containers retained their exact IDs. Only catalog was recreated using `docker compose up -d --no-deps --no-build catalog`.
- Release and source/image rollback evidence: `/opt/muonroi/catalog-releases/20261015-stepfun37-8da0d150384a/`. Previous image retained as `muonroi-catalog:rollback-20261015-stepfun37`. Acceptance failure would restore the previous four source files and image automatically.

## Verification and limits

- Before changing JSON, the new support/routing expectations failed: 2 failed / 41 passed. Real-catalog tests were updated for the retirement; the finite-output synthesis regression now uses isolated fixture metadata so its original assertion remains covered.
- Final focused CLI suite: 120 files / 1,337 tests passed, native exit 0. Covers models, providers, router, PIL, leader selection, synthesis output budgets and fallback observability.
- FastAPI: 19 tests passed, native exit 0. Build: native exit 0.
- Workspace native selfverify: smoke-boot 1/1 passed, 0 failed; two council surfaces skipped because they lack registered openers. Run `cc712833-913c-409b-be44-514258dbafca`.
- The earlier 9,050-test full run belongs to the preceding client cancellation fixes and predates this catalog migration. It is not claimed as a full-suite run of the new catalog. See `stepfun-client-fix-2026-10-15.md` for those fixes and the separately verified resume guard.
- No paid StepFun inference was used here. This proves catalog publication, routing and boot, not the disappearance of upstream HTTP 429. No commit/push or whole-stack update was performed.
- Reopen existing CLI processes to load the rebuilt code and clear their module-level 24-hour catalog cache. An old session that explicitly stores a retired model can be reopened with an explicit current model; session history was not rewritten.

## Diagnostic tools and evidence

Local tools and raw results are retained under `.scratch/stepfun-37-catalog/`: `update_catalog.py`, `inspect_remote.py`, `release/deploy.py`, `release/smoke.py`, `cli-live.mjs`, `remote-before.json`, `remote-after.json`, `cli-live-result.json`, `accepted-tests.log`, `python-tests.log`, `build.log`, `deployment.log`, and `selfverify-result.json`. The remote release retains its UTF-8 `verification.json`, rollback source and manifest. Credentials were read only into process memory and were not logged or included in the report.

The original historical support ZIP remains unchanged and retains the pre-fix/pre-migration measurements.
