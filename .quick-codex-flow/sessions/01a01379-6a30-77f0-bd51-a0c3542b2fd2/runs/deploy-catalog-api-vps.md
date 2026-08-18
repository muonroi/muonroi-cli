# Run: Deploy Catalog API to VPS

## Requirement Baseline
Original goal:
- Deploy the current catalog API, including StepFun catalog updates, to the user's VPS.

Required outcomes:
- R1: Identify the intended VPS, deployment topology, and service path from repository or configured local access.
- R2: Deploy commit `df47b23a` without overwriting unrelated VPS workloads.
- R3: Verify the live catalog API health and the StepFun catalog response after deployment.

Constraints:
- Do not infer an SSH destination, deployment directory, domain, port, or credential.
- Preserve existing services and perform read-only remote inspection before any deployment action.
- Do not expose credentials, tokens, or private host details in user-facing output.

Current gate:
- research

## Gray Area Register
| ID | Type | Question | Resolution path | Status |
|---|---|---|---|---|
| G1 | deployment target | Which configured VPS and remote path serve catalog-api? | verified in `D:/sources/Core/CLAUDE.md`: `/opt/muonroi` on the documented VPS | resolved |
| G2 | safety | What deployment command updates only catalog-api and supports rollback? | remote compose inspection | resolved: pull CLI worktree, build and restart only `catalog` |
| G3 | verification | Which public/private URL is the live health and catalog endpoint? | inspect service/proxy configuration | resolved: public `catalog.muonroi.com`; local catalog bind `127.0.0.1:8086` |

## Evidence Basis
- Local repository provides `services/catalog-api/Dockerfile` and its FastAPI service, but no deployment destination has yet been established.
- The user authorized deployment, not selection of an unknown VPS target.

## Research Result
- SSH alias `eberth-vps` connects successfully, but that host contains neither `/opt/muonroi` nor a catalog/muonroi Docker container.
- The repository README's declared `/opt/muonroi/update.sh` deployment path is absent on that host.
- `https://catalog.muonroi.com/health` is live and reports catalog version `2.16` dated `2026-07-29`; the prepared local release is version `2.18` at commit `df47b23a`.

## Deployment Target
- `D:/sources/Core/CLAUDE.md` identifies the canonical catalog VPS, `/opt/muonroi` path, and `/opt/muonroi/update.sh` deployment script. It also records Apache as the reverse proxy.
- The canonical CLI worktree is `/opt/muonroi/muonroi-cli`; the remote `develop` commit was `0806be0a` before this release.
- The generic update script rebuilds multiple services, so this release uses the narrow catalog-only compose actions instead.

## Verification Preflight
- Local typecheck passed.
- Configured full unit suite (`bun run test` → `bunx vitest run`) passed: 712 files passed, 6 skipped; 6,144 tests passed, 10 skipped, 2 todo.
- The public health endpoint before deployment reports catalog version `2.16`, dated `2026-07-29`.

## Next Action
- Push the release commits, pull `develop` in the CLI worktree, build/restart only `catalog`, and verify `/health` plus `/api/v1/models?provider=stepfun`.
