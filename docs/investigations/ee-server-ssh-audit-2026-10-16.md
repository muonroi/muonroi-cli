# EE server audit over SSH

The owner requested a direct server check using the existing SSH key. This audit inspected service state, deployed source, one authenticated loopback recall, and upstream source. No live service restart or deployment was performed.

## Actual running service

- Host: `srv1156244.hstgr.cloud`, accessed as `phila` with the existing SSH identity; no key contents or API credentials were printed.
- User unit: `experience-engine.service`, active/running, PID **651209**.
- Service start: **2026-09-27 02:42:03 UTC**.
- Actual process cwd and checkout: `/home/phila/experience-engine`.
- Actual executable: `/home/phila/.nvm/versions/node/v22.22.2/bin/node`, script `server.js`.
- Branch `develop`, clean tree, HEAD **`951d08dee518d473672364f81e35a63c25234297`**.

The deployed server is modular: `server.js` delegates to `api/routes.js` and `api/handlers/knowledge.js`. The older local EE checkout inspected earlier has a monolithic server; it was not used as proof of deployed code in this audit.

## Confirmed source contract mismatch

`api/routes.js:61` routes `POST /api/recall` to `handleRecall` with write access. `api/handlers/knowledge.js:210` implements the handler:

- It reads query, cwd/project metadata and `fast`.
- It invokes the core with `{ recallMode: true, fast }`.
- It does not process or forward `strict_project`.
- It returns only `text`, `entries`, `count`, and `query`, with no scope proof.

Its comment explicitly describes recall mode dropping the positive project/language/framework scope gates. This is source evidence of the broad-recall design, not a measurement of which returned entries belong to another project; returned lesson content was deliberately not logged.

Deployed handler SHA-256: `d8bc57da94936790f9773a8770f471c20d64198a48e2cad198c3df2bcaa0d97a`.

## Runtime experiment on the server

Measured **2026-10-16T07:20:11.947Z**, using SSH and loopback HTTP with auth/port resolved through the deployed `api/config` module. No token was placed in shell arguments or output.

Request: project-specific CLI conventions, cwd `D:/sources/Core/muonroi-cli`, `strict_project=true`, `fast=true`.

| Measurement | Actual result |
|---|---|
| Health HTTP | 200 |
| Recall HTTP | 200 |
| Recall elapsed | **54 ms** |
| Response keys | `text`, `entries`, `count`, `query` |
| Entry count | **21** |
| Scope proof | absent |
| CLI matching strict-proof check | false |

All lessons were omitted from saved output. The normal recall request can record its surface/activity in the EE brain; no production code/configuration, collection maintenance or deployment action was performed. The 54ms result is one warm, fast-mode loopback observation; it must not be compared directly with the earlier 8,104ms client probe as a controlled network-latency experiment.

This bypasses the Windows CLI, TUI, GSD, and public HTTP proxy. The same missing proof exists at the server itself. The CLI's `ee_scope_unverified` refusal is therefore the expected result of the current incompatible contracts, not failed SSH, expired credentials, exhausted quota, or GSD plan review.

## Is an existing upstream fix waiting to deploy?

Read-only `git ls-remote` reports upstream develop **`f64349532c1260314a7e19f20e3860db2aedb5b2`**, dated September 29. The server's stored origin/develop still points to its September 27 deployed commit.

The upstream commit was fetched into an isolated temporary bare repository, inspected, then removed. The live checkout/ref state was not fetched, checked out, or pulled. Its `api/handlers/knowledge.js` and server entry still contain no handling of `strict_project` or strict scope proof. Deploying that branch tip is not an established fix for the strict recall contract.

## Required fix and limits

The EE server must implement actual project filtering before returning a matching proof. Define explicit project versus caller-cwd resolution, treatment of global lessons, and canonical Windows/home-relative paths; verify isolation with contrasting project fixtures. Return proof only for enforced filtering, then replay through both loopback and the actual compiled CLI client.

Do not merely add `strict:true`, disable the client guard, or restart the existing binary. This audit does not claim an implemented fix, deployment, cross-project isolation test pass, or a rate-limit cause. The GSD installation issue remains a separate finding in [the block audit](gsd-ee-block-audit-2026-10-16.md).

Private sanitized evidence: `.scratch/ee-server-audit/remote-state.log`, `entrypoint.log`, `handlers.log`, `loopback-proof.json`, `upstream.log`, `upstream-source.log`, `final-state.log`. Original server checkout stayed clean and the PID remained unchanged.
