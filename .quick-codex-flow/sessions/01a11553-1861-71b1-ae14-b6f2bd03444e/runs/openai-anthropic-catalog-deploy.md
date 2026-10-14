# Current OpenAI and Anthropic catalog deployment

## Resume Digest
- Goal: user explicitly requests latest OpenAI/Anthropic models in catalog.json and FastAPI, followed by deployment.
- Gate: research. Execution: auto, including the requested deployment once verified.
- Scope: bundled catalog, its model/schema consumers when required, services/catalog-api and its own deployed service. Preserve all existing CLI repair/user WIP and other running VPS services.
- Source: official OpenAI model pages (gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna) and Anthropic current lineup (Fable 5.1, Opus/Sonnet/Haiku 5.5), fetched 2026-10-08.
- Canonical data: services/catalog-api/Dockerfile copies src/models/catalog.json. No second model catalog exists in FastAPI; its Pydantic schema must retain relevant new fields.
- Open questions: verified deployment target/compose context and exact billing metadata for context-dependent rates; preserve old IDs and aliases without collision.
- Research evidence: OpenAI context 1,050,000/output128,000; Responses required for reasoning tool calls. Anthropic context1,000,000/output128,000. New Claude default efforts differ from prior rows. Price tables include cached reads/writes and prompt-length pricing.
- Deployment docs in services/catalog-api/README.md refer to /opt/muonroi/update.sh and sibling deploy/docker-compose.yml; local sibling deploy is older and lacks catalog, so do not execute it or update all services.
- Verification plan: official-field manifest; CLI catalog validation/registry/capability tests; FastAPI Pydantic/endpoint tests; build; deploy only catalog after checking live context; remote health/full model response/hash verification and CLI consumption.
- No push required yet. If push becomes necessary, full unit suite must pass first. Do not ship unrelated WIP through a whole-repo sync.
- Next action: inspect deployment host/service read-only; fetch per-model thinking/effort and prompt-length pricing contracts.

## Research closure and verified plan (2026-10-08)
- Gray areas resolved: Docker labels prove /opt/muonroi compose + override, catalog build context /opt/muonroi/muonroi-cli, port127.0.0.1:8086, no mounts. Prior image/source hashes captured in catalog-remote-before.json. Live2.18 has the same legacy OpenAI IDs as local2.19; preserve all existing IDs.
- Official pages prove eight current text/image models, reasoning efforts, 128K output and 1M/1.05M context. New GPT6 rates increase above272K input; Haiku5.5 above100K. Represent this optional contract as long_context_pricing threshold + multipliers; all input categories share input multiplier. No ID conditionals in runtime.
- Runtime gap: Anthropic capabilities serialize adaptive catalog models as enabled + budgetTokens. Installed SDK supports adaptive and output_config.effort. Official thinking docs configure adaptive models via type=adaptive, no manual budget. SDK-wire regression will capture the current wrong request before repair.
- Scope: eight rows before each provider's legacy rows; older canonical/versioned aliases remain selectable; short Claude aliases follow newest family. Opus5.5 premium, Sonnet5.5 balanced, Haiku5.5 fast; Fable5.1 premium after Opus. GPT6 Astra premium,6.1 Sol balanced,Luna fast;6 Sol selectable. Preserve switch-provider order and other providers' metadata.
- Conditional pricing must survive FastAPI, CLI Zod and ModelInfo; use threshold per request in lookup/usage projections. Sprint previews price ordinary calls separately from debate volume so cumulative sprint input cannot select a per-request surcharge.
- Protected boundaries: user credentials/settings, all prior local repairs/WIP, remote git checkout and other services. No push. Deploy a four-file build context (catalog/main/requirements/Dockerfile) in an isolated release folder, tag existing image for rollback, build muonroi-catalog tag and recreate only catalog via existing compose --no-deps --no-build. Record rollback and leave unrelated containers unchanged.
- Wave1: regression tests -> catalog/schema/pricing/capabilities implementation -> focused Vitest+pytest, typecheck/build/native boot.
- Wave2 (depends on green wave1): checksum upload -> image build -> catalog-only recreate -> container health and authenticated localhost/public response verify -> CLI Zod consumption of saved public payload.
- Plan-check PASS: source has one canonical catalog; schema retains metadata; pricing tested on boundary/cached input; preserve aliases and default-provider order; deployment reversible without pushing dirty repo.
- Gate: execution; active wave1; approval: deployment explicitly requested. Risks: public cache/CLI24h cache; provider access depends on account entitlement. Verification will prove catalog publication and SDK contracts, not entitlement.

## Wave1 verification
- Before repair: Vitest11 failures (missing eight rows, missing conditional pricing, adaptive SDK wire sent enabled/budget10000); FastAPI regression KeyError: modalities. Logs catalog-before-tests.log/catalog-api-before.log.
- After:57 files/570 tests pass across providers/models/estimator/preview;19 FastAPI tests pass. Typecheck/build exit0;33 deterministic registry tests pass after adding current tier/legacy alias checks.
- Native selfverify44d58244-34f5-4cfa-aefe-70fa8cc876db:1/1 pass, boot only. Public entitlement not tested.
- Scoped formatting applied; unrelated WIP including existing PIL CRLF/trailing diff remains untouched.
- Wave1 done; Wave2 deployment active. Tag current muonroi-catalog image for rollback; recreate only catalog from isolated four-file image.

## Deployment source persistence decision
- Read-only remote git status for exactly catalog.json/main.py/requirements.txt/Dockerfile was empty. These four source files are clean. Preserve all other remote files; back up the four current files inside the isolated release and replace only them after candidate image smoke passes. This keeps subsequent normal Compose builds current, without git pull/reset/push or whole-repo transfer. Image/source rollback is automatic on deployment failure.
- Mounted OAuth selection harness3/3 pass9.10s with the updated bundled catalog.
- Release /opt/muonroi/catalog-releases/20261008-2.20-a95fbfe00871 uploaded; four-file SHA256 manifest enforced before build. Prior image c339443a1334 tagged for rollback. Deployment log catalog-deployment.log.

## Goal audit / wave2 close
- Docker candidate sha256:2b951851c116f0b41e0775c38628bd711e24107f08e4c4f16c9cc4c61d48e7d0 deployed healthy. Version2.20/date2026-10-08/model_count51. Image TestClient smoke verified modalities/conditional pricing for every source row using pinned image dependencies.
- All13 other running containers kept the same IDs. Rollback image muonroi-catalog:rollback-20261008-c339443a1334 and source backups saved inside isolated release.
- Authenticated localhost and public models responses HTTP200, identical ETag1017a6b95382b208. Eight new models' limits/pricing/cache/thinking/vision/modalities/conditional rates verified against canonical source. All four remote source checksums match uploaded manifest.
- Python default urllib user agent hit Cloudflare1010/403; rerun using undici (Node fetch UA) passed. Node public health also200. No server/client security settings changed.
- Built CLI fetchCatalogDocument made exactly one authenticated public request HTTP200, consumed2.20/51models; seven automatically eligible current OpenAI/Anthropic rows and five pricing-threshold records survived Zod/runtime mapping. GPT6Sol is explicitly selectable but not automatic; all eight rows checked in SDK/catalog tests and public payload.
- Native boot1/1 and mounted OAuth3/3 pass. Focused provider suite570pass, Python19pass; registry33pass after one extra routing guard. No full-suite rerun and no git push/commit. Scoped diff-check exit0. Source/typecheck/build succeeded; final typecheck pending in catalog-final-typecheck.log.
- Goal achieved: current model rows, catalog service retains contract, deployment/public consumption proven. Credentials/user settings untouched; running CLI instances must restart to clear in-memory catalog cache. Account entitlement/model inference was not tested with paid requests.
- Gate: completion; no outstanding product work. Next: finish final typecheck and write memory note, then report verified deployment.

## Final acceptance
- Final typecheck exit0 (catalog-final-typecheck.log). Scoped diff check clean. Memory note written under Codex permitted ad-hoc notes.
- Status COMPLETE. No required work remains for model catalog update and catalog API deployment. Final response names live version/endpoint and tests; restart built CLI for immediate catalog refresh.
