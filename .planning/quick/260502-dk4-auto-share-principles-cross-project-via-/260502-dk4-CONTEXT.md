# Quick Task 260502-dk4: Auto-share principles cross-project via EE brain - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

<domain>
## Task Boundary

Enable cross-project principle sharing for users who run multiple projects on the same EE brain. Currently EE penalizes hints from other projectSlugs, reducing cross-project value. Need ecosystem-level scope detection so related projects treat each other's principles as local.

</domain>

<decisions>
## Implementation Decisions

### Scope Model
- **Ecosystem scope** — detect when projects belong to the same ecosystem
- CLI sends `ecosystem:<name>` scope in intercept/extract requests
- EE server unchanged (CLI-side only change)

### Detection Method
- **Config-based with git remote pattern matching** — generic for all users
- User defines ecosystem patterns in `~/.muonroi-cli/user-settings.json`
- Match against git remote URL (e.g., pattern "muonroi" matches any remote containing "muonroi")
- No hard-coded paths — works across machines and directory structures
- Fallback: if no ecosystem config, current behavior preserved (repo/branch scope)

### Change Scope
- **CLI-side only** — CLI sends ecosystem scope, EE server accepts it via existing scope payload
- EE server's projectSlug penalty still applies for truly unrelated projects
- Same-ecosystem projects get ecosystem scope label instead of individual repo scope

### Claude's Discretion
- Config format: `{ "ecosystem": { "name": "muonroi", "patterns": ["muonroi"] } }` in user-settings
- scope.ts ecosystem detection runs during buildScope() — cached per session
- Extract session sends ecosystem scope too so principles get stored with ecosystem context

</decisions>

<specifics>
## Specific Ideas

- scope.ts already has `ecosystem` kind defined in Scope type but never populated
- buildScope() currently produces global/repo/branch — add ecosystem detection between global and repo
- Intercept requests already include scope — ecosystem scope flows through existing pipeline
- extractSession sends projectPath — add scope to meta so EE stores ecosystem context

</specifics>
