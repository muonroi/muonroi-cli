# Phase 23: EE-driven BB Package Design

## Why

`/ideal` "Init new project" flow has a verified gap (investigated 2026-05-19):

1. `fetchBBContext()` returns structured `BBContext.packages[]` from the brain
   (`src/ee/bb-retrieval.ts:56-65`), but the council only consumes it as **prose
   text** via `renderBBContextBlock()` (lines 398-402) — the structured data is
   discarded before reaching scaffold.
2. `InitNewOptions.eePackages` exists (`src/scaffold/init-new.ts:189`) and the
   guard at line 475 would inject `Directory.Packages.props` correctly — but the
   TUI callsite (`src/ui/app.tsx:4238`) never fills it. `eePackages` is always
   `undefined`.
3. `installBBTemplates()` is exported (`init-new.ts:151`) but has **0 production
   callsites**. When the user picks "Init new project" → form calls
   `dotnet new mr-base-sln` → fails because the template package was never
   installed → catch block silently falls through to a `git clone` of
   `${HOME}/muonroi-building-block` (path doesn't exist on Windows) → user sees
   "Scaffold failed: git clone ... fatal: not a git repository".
4. Brain content on VPS is ALREADY structured enough — verified via
   `http://72.61.127.154:8082/api/search`: `bb-recipes` has entries shaped
   `Template <name> (<shortName>): <desc> | uses: <pkg1>, <pkg2>, ...` and
   `experience-principles` has commercial-license flags per package. No council
   debate needed for BE package design — a deterministic extractor suffices.

## Goal

Replace the broken "council-debates-in-prose → undefined eePackages → silent
clone fallback" pipeline with a deterministic EE-driven flow:

1. `designBBPackages(intent)` reads top-scoring template recipe, parses the
   `uses:` list, filters commercial packages against `experience-principles`,
   returns `{template, packageIds, commercialBlocked, behavioralHints, rationale}`.
2. `init-new-form-card` previews the design, lets user toggle packages off, then
   confirms.
3. `initNewProject` auto-installs only the chosen template via
   `installBBTemplates()`, runs `dotnet new`, then `dotnet add package <id>` for
   each entry in `eePackages`. Legacy `git clone` fallback is removed.

## Non-goals

- Council debate refactor for FE/UX/architecture (still council-driven).
- Brain content cleanup (bb-behavioral has 3 duplicate entries — note for
  experience-engine team, not blocking).
- Multi-template scaffolds in one project (mr-base + mr-micro side-by-side).
- BB version-bumping automation (pinned versions in `BB_TEMPLATE_PACKAGES` are
  manually updated when nupkg version changes — out of scope).

## Depends on

- Phase 21 (graceful EE-timeout degrade) — `withEeTimeout` + `ee-timeout` event
  already shipped; this phase reuses both for the EE-down fallback path.
- BB templates published to NuGet (Muonroi.BaseTemplate@1.0.0-alpha.3,
  Muonroi.Modular.Template@1.10.0, Muonroi.Microservices.Template@1.10.0) —
  shipped.

## Success criteria

- `bun run src/index.ts -d <empty-dir>` → `/ideal "build a todo api"` →
  "Init new project" → form shows `mr-base-sln` template + OSS packages list →
  user confirms → project scaffolded with `Directory.Packages.props` filled +
  `dotnet add package` ran successfully for each.
- EE down (set `MUONROI_EE_BASE_URL=http://127.0.0.1:1` to force timeout) →
  form falls back to current manual template menu — no crash, no silent clone.
- `bunx vitest run tests/scaffold/ tests/harness/init-new-*` all green.
- `installBBTemplates()` callsite count > 0 (grep production code).
- `git clone` removed from `init-new.ts` production path.

## References

- `src/ee/bb-retrieval.ts:56-65,245-374,398-402` — existing BBContext shape +
  prose renderer that drops structured data.
- `src/scaffold/init-new.ts:151,189,412,475,518-522` — installBBTemplates,
  eePackages, initNewProject entry, props guard, clone fallback.
- `src/ui/app.tsx:4230-4258` — Init new form confirm handler (no eePackages).
- `src/ui/components/init-new-form-card.tsx` — current form UI.
- Brain probe results (VPS http://72.61.127.154:8082): recipes return
  `mr-micro-sln` for "microservice with redis" (score 0.674), `mr-base-sln` for
  "simple web api with database" (score 0.62). Commercial packages flagged in
  `experience-principles`: Muonroi.AuthZ, Muonroi.ServiceDiscovery.Consul,
  Muonroi.Bff.
