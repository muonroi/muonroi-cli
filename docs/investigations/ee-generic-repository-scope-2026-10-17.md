# Generic native EE repository scope: no per-repository registration

## Corrected requirement

Registering ai-dock alone resolved one deployment symptom but left every new repository dependent on another manual registration. The user rejected that as the complete solution. Native recall must identify a real repository automatically, remain stable from subdirectories/worktrees, and keep project filtering strict.

The related TUI repair is complete: internal ACK guidance is hidden from user tool cards while retained for the model; worker results stay verbatim; both legacy and labelled delegation-list formats render correctly. See `delegation-display-2026-10-17.md`.

## Reproduction

- Before the generic EE deployment, the rebuilt native client sent filesystem-derived repository metadata for a genuinely initialized, randomly named Git fixture and a new marker project. Actual EE returned400 for root, nested cwd and the marker project. These names were never in server repoPatterns.
- The server regression also demonstrated a separate error: an unregistered repository nested under a registered parent was assigned the parent's project, returning that parent's lessons. The repaired strict HTTP fixture now isolates the nested repository and omits parent/global lessons.
- Evidence: `.scratch/ee-generic-scope/{cli-red.log,ee-red.log,live-before.json}`.

## General solution

### Native client

`src/ee/project-identity.ts` resolves the actual local repository boundary from Git metadata. Origin supplies a canonical project name; worktree gitdir/commondir metadata leads to the same common origin. A repository without an origin uses its root name. Non-Git projects use real ecosystem markers such as package.json, pyproject.toml, Cargo.toml, go.mod and .NET project files. An ordinary directory without markers, a relative cwd, or a nonexistent path does not create an identity.

Strict recall with no explicit project sends optional `repository={root,project}` through the existing authenticated recall request. This uses no model inference, project-discovery call, shell/network Git operation or extra recall retry. Explicit target project retains priority. A strictly verified empty response can bind the task and let the native write tool record its first lesson in that project; a mocked native integration test covers that first-use flow without creating a live lesson.

### EE source

The server now supports this optional protocol context in `lib/repository-context.js` and `api/handlers/knowledge.js`:

- Validate concrete project syntax, absolute root shape, cwd containment and path normalization, including Windows/client-home paths. Reject malformed identities, root escape, drive mismatch and wildcard/global selectors.
- Preserve explicit project_slug and exact configured root/project aliases. A registered ancestor does not override a separate nested repository.
- Apply the existing project-only hit filtering, graph isolation and surface checks to the resolved project. New projects with no lessons return200 and zero entries with proof.
- Return `scope.repository` proof for a request that supplied repository context. The CLI rejects legacy responses that ignore that context instead of accepting a parent project's response. Explicit legacy requests remain compatible.

The repository metadata is an authenticated client assertion, equivalent in authority to the existing explicit project_slug API. The server cannot inspect a remote Windows filesystem. The native client establishes local filesystem evidence; the server validates the protocol and enforces the corresponding project filter. This adds no filesystem, workflow or permission authority to the model.

## Deployment and removal of the one-off registration

EE source revision **cddb6fc1f07a461f640138059e44868801e4e1b0** was committed in isolated worktree `D:/sources/Core/experience-engine-worktrees/generic-scope-20261017` and deployed via a local Git bundle, without an upstream push. The older original checkout and its WIP were preserved.

Deployment required the exact clean predecessor2187ba68b681, fast-forwarded the live develop checkout, ran8 targeted tests using the service's Node22 binary, and restarted the same user service. It also **removed the earlier ai-dock entry** from repoPatterns. The original nine aliases remain for compatibility; no random fixture project was added. All other config values were preserved except expected installCommit/installCommitDate stamps.

- Service active, PID1466551; installCommit cddb6fc1f07a; remote working tree clean.
- Protected rollback config: `/home/phila/.experience/config.json.generic-scope-backup-2026-10-17T08-18-15-424Z`, mode0600.
- Exact deployment: `.scratch/ee-generic-scope/deployment.json`.

## Actual native runtime acceptance

Fresh client and configured EE URL/auth, UTC08:18:59–08:19:43, seven recall requests total; no discovery or automatic retries:

| Case | HTTP | Enforced project | Count | Elapsed ms |
| --- | --- | --- | --- | --- |
| New Git fixture root |200|probe-77c554f4-64f|0|6663|
| Same Git repo, nested cwd |200|probe-77c554f4-64f|0|10072|
| New non-Git marker project, src cwd |200|marker-e43140ea|0|4640|
| Separate new Git repo inside CLI checkout |200|nested-958a1bfd-683|0|8582|
| AI Dock, after removing its registration |200|ai-dock|0|4612|
| Explicit CLI target from another cwd |200|muonroi-cli|0|9116|
| Nonexistent non-repository cwd |400|none|n/a|40|

All automatic cases had strict project-only and matching repository proof. Explicit project retained priority. Configured native health returned200. These8 acceptance checks passed. Tests recorded no live lesson content or credentials, and no lesson was created or edited; normal recall may record surface/activity metrics. These observations do not prove a latency improvement or relevance quality on nonempty collections.

## Verification summary

- CLI:62 focused tests passed in6 files, covering identity, worktrees, markers, explicit targets, new/legacy proof, scope rejection, first-use learning and display projection. Build exit0; scoped diff check0.
- EE: npm test535 pass; test:unit534 pass/9 platform skips; test:tools111 pass. No failures. Remote Node22 repository/strict-recall tests8/8.
- Fresh rebuilt native/MCP/TUI controls16/16; native selfverify2/2, run d2690cac-8f76-4df7-8468-4d0834d7e0c1.
- Earlier display acceptance:30 tests; compiled component and resumed actual Bun TUI7/7; native selfverify2/2. Semantic frames do not contain full rendered glyph text, so that control claims component-boundary content correctness plus real TUI resume, not a screenshot comparison.
- No full CLI suite, paid generation trial or upstream push. EE source is deployed; CLI source/dist are rebuilt locally. Existing loaded CLI processes must restart with `bun D:/sources/Core/muonroi-cli/dist/src/index.js` to send the new context and load the display repair.

Evidence manifest: `docs/investigations/evidence/ee-generic-repository-scope-2026-10-17.json`.
