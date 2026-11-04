# EE strict project scope: implemented and deployed

The owner authorized fixing strict recall, checking out/pulling develop, setting up the service, deploying, and checking health. Deployment is accepted at **2187ba68b681a86a956b782859baa05908a9d221**.

## Source and implementation

An isolated worktree at `D:/sources/Core/experience-engine-worktrees/strict-project-20261016` checked out develop and pulled upstream **f64349532c1260314a7e19f20e3860db2aedb5b2**. The original `experience-engine` checkout, branch and unrelated WIP were preserved.

The strict request now validates the boolean flag and resolves a concrete project from explicit `project_slug` or existing server caller metadata. It enforces project-only identity before formatting, surface tracking and graph expansion. Missing/global, malformed, conflicting or foreign identities are excluded, including legacy identity fields. Scope proof is returned only for this enforced path. Calls without `strict_project=true` retain broad recall behavior.

An unknown/unmapped cwd must supply an explicit project slug from `/api/projects`; the server does not invent a repository or silently widen recall. Strict mode deliberately excludes unscoped/global lessons.

Changes are in `.experience/experience-core.js`, `api/handlers/knowledge.js`, `tests/recall-strict-project.test.js`, API documentation and the deep map. Two existing test fixtures were also made environment-independent: the metrics fixture now sets/restores USERPROFILE as well as HOME; the brain-budget fixture explicitly pins its mocked Ollama endpoint.

## Verification

| Check | Measured result |
|---|---|
| New strict fixtures before implementation | 4 failed |
| Focused strict/API/legacy golden tests | 40 passed |
| Fixture isolation regressions | 18 passed |
| Full `npm run test:ci`, server Node **22.22.2/Linux** | **1,171 passed, 0 failed, 14 skipped** |
| Full `npm run test:ci`, Node **24.19.0/Windows** | **1,176 passed, 0 failed, 9 skipped** |
| Source syntax checks | Both changed runtime JS files accepted by Node 22 |
| Source transfer | All **368** file hashes matched the tested staging archive before activation |

Each full suite contains 1,185 discovered tests across API/runtime/tool groups. Skips differ by platform; they are not passes. The first Windows run failed one metrics fixture, now fixed and rerun. An initial Linux runner-wide Ollama override conflicted with a mocked endpoint assertion; after isolating that fixture, the full final Linux run passed. An intermediate slow run was stopped only for verified descendants in the private staging workspace; the live service was excluded.

EE has no npm runtime or development dependencies. Setup used the installed Node22/npm and `npm install --ignore-scripts --package-lock=false --no-audit --no-fund`; no model/catalog configuration seeding was run.

## Deployment and rollback

- Host/user: `phila` on the existing EE server; repo `/home/phila/experience-engine`.
- Previous deployed commit: **951d08dee518d473672364f81e35a63c25234297**.
- Live checkout was checked for cleanliness, checked out develop and pulled upstream with `--ff-only`.
- The tested fix was transferred as a Git bundle and fast-forwarded to **2187ba6**. No `git push` was performed; local and server develop contain this one commit above upstream f643495.
- Only user unit `experience-engine.service` was restarted. Final accepted process PID: **199912**.
- Retained release/rollback path: `/home/phila/.experience/releases/strict-project-20261016/`, including `rollback.bundle`, tested source manifest, Linux logs, deployment state, and a mode-0600 config backup. No key/token contents were logged or copied into the public report.

The first activation passed functional acceptance but rolled back because a byte-level config comparison detected a change. Inspection proved the existing unit runs `.experience/sync-install.sh --quiet` in ExecStartPre. That hook stamps `installCommit/installCommitDate`. Deployment verification was corrected to permit exactly these two metadata fields while comparing every other setting structurally. The second activation passed; functional configuration and credentials remained unchanged. The automatic rollback and first-attempt evidence were retained.

No Qdrant migration, collection maintenance, user data deletion, unrelated service restart, or provider/model pin change was performed.

## Live acceptance

Accepted loopback probe at **2026-10-16T07:47:08.735Z**:

- `/health`: HTTP 200, overall **ok**, Qdrant **ok**, embedding **ok**, FileStore **ok**.
- `/api/version`: commit **2187ba68b681**.
- Strict recall with caller cwd `D:/sources/Core/muonroi-cli`: HTTP 200, **3 entries**, matching project/cwd proof, **1,355 ms**. Each returned entry's stored identity was re-read and confirmed as `muonroi-cli`; lesson text was omitted from artifacts.
- Strict recall for a nonexistent explicit project: **0 entries**, null text, matching proof, **77 ms**.
- Non-boolean strict flag: HTTP **400**.

Actual compiled native CLI `ee_query` was then executed on Windows using normal auth/endpoint resolution:

- Cwd-derived project: **3 entries**, accepted; **5,376 ms**. No `ee_scope_unverified` or `ee_unavailable` result.
- Explicit nonexistent project: **0 entries**, accepted; **5,113 ms**.

These are individual functional observations, not controlled latency benchmarks. Normal recall may run configured embedding/routing work and records recall surfaces. No lesson contents or credentials were printed.

The configured public address also returned health **ok** and commit **2187ba68b681**. Independently, `https://experience.muonroi.com/health` and its authenticated version endpoint returned HTTP **200**, health **ok**, and the same commit at **2026-10-16T07:48:29.716Z**. Endpoint settings were not changed.

The separate old CLI/MCP installation issue described in [the GSD audit](gsd-ee-block-audit-2026-10-16.md) is unchanged by this server release. Existing clients that already send strict requests benefit from the server fix immediately; local GSD code changes still require loading the rebuilt CLI/MCP installation.

## Evidence

Private reproducible scripts/logs: `.scratch/ee-strict-scope-deploy/` (`stage-test.py`, `deploy.py`, `acceptance.cjs`, source manifest/archive, Git bundle, full Windows/Linux logs, deployment state, `cli-native.mjs`, native results, public/domain health probes). Public evidence hashes are in `evidence/ee-strict-scope-deployment-2026-10-16.json`.
