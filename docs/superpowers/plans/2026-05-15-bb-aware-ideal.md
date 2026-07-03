# BB-aware `/ideal` — Experience Engine Refinement & Scaffold Integration

> **For agentic workers:** REQUIRED SUB-SKILL — Use `superpowers:subagent-driven-development` to execute task-by-task. All steps use `- [ ]` checkbox syntax.

## Why

`muonroi-building-block` (BB) is a .NET meta-framework with **60+ packages** across 4 families (Core, Governance, RuleEngine, Infrastructure) with OSS/Commercial boundary. The Experience Engine (EE) at `experience.muonroi.com` already has rich behavioral rules for BB (rule engine, tenancy, auth, caching, EFCore — all top-k scores ≥0.65), but they are interleaved with rules from other projects in a single `experience-behavioral` collection. `/ideal` cannot do BB-aware retrieval today.

Three concrete problems surfaced by the EE coverage probe (2026-05-15):

| Problem | Evidence | Fix in this plan |
|---|---|---|
| BB rules mixed with storyflow / muonroi-cli / etc | All `[MExtractAsRule]` hits live in `experience-behavioral` alongside React/Angular rules | **Phase 2** — namespace `bb-behavioral` collection |
| Path fragments split BB intercepts across 5+ buckets | `D:/Personal/`, `/d/Personal/`, `/d/sources/`, `D:/sources/`, `/home/user/` all distinct project keys in `/api/stats` | **Phase 1** — server-side path canonicalization → `project_slug` |
| No sample-as-recipe retrieval | Query "fraud detection" → returns auth/JWT rules instead of `samples/FraudDetection` | **Phase 3** — ingest `samples/*/README.md` + `REPO_DEEP_MAP.md` sections into `bb-recipes` |

Downstream consumer: `src/scaffold/init-new.ts` currently clones the entire BB repo. After this plan it queries EE first, picks the closest sample template, then `dotnet new muonroi-service` + cherry-picks packages by intent.

### Sibling plan

This plan **builds on top of** `docs/superpowers/plans/2026-05-15-ideal-ee-native.md` (P1/P2/P3 — generic EE integration). Where that plan wires the EE read-path (`PIL Layer 3 injection`) and write-path (`/api/extract` on run completion), **this plan adds BB-domain content** to those pipes. The two plans can ship in parallel — no file overlap.

## Architecture context (read before starting)

- **EE collections today**: `experience-behavioral`, `experience-principles`, `experience-selfqa`, `experience-mistakes`, `experience-stored`. No `bb-*` collections exist yet. Server enforces a `KNOWN_COLLECTIONS` whitelist in `server.js` — adding a new collection requires updating that set or queries silently return empty.
- **EE server**: `D:/sources/Core/experience-engine/server.js`, route handlers in `handleSearch`, `handleExtract`, `handleStats`. Project bucket key is derived from intercept payload path. **API note**: `handleSearch` accepts `body.collections: string[]` (plural array), NOT `body.collection: string`. All curl examples and code in this plan use the plural form.
- **Thin-client config**: `~/.experience/config.json` — `serverBaseUrl`, `serverAuthToken` (write), `serverReadAuthToken` (read). Helper at `~/.experience/exp-feedback.js`.
- **BB structured assets** (do NOT re-document — parse):
  - `REPO_DEEP_MAP.md` (455 lines, file-level table per package)
  - `README.md` §Package Families (OSS vs Commercial table)
  - `OSS-BOUNDARY.md` (license boundary matrix)
  - `samples/*/README.md` (FraudDetection, LoanApproval, MultiTenantSaaS, Quickstart.RuleEngine, Quickstart.DecisionTable, RuleSourceGen)
  - `schema/*.json` (workflow, audittrail, antitamper, distributedcache, messagebus, ui)
  - `scripts/check-modular-boundaries.ps1` (rule logic for OSS/Commercial gate)
  - **Note**: `templates/content/{muonroi-service,muonroi-site}` inside BB are NOT the production scaffold templates — see next bullet.
- **Production `dotnet new` template repos** (separate sibling repos under `D:/sources/Core/`):
  - `Muonroi.BaseTemplate/` — Clean/Onion Architecture starter, consumes `Muonroi.BuildingBlock` as NuGet
  - `Muonroi.Modular.Template/` — Modular Monolith template (`.nuspec` ready for publish)
  - `Muonroi.Microservices.Template/` — Distributed microservices + YARP Gateway template
  - Each has its own `.sln`, `.csproj`, `.template.config/template.json`, `README.md`, `AGENTS.md` (~123 lines each). None have `REPO_DEEP_MAP.md` yet.
  - These are the repos `dotnet new install Muonroi.{Base,Modular,Microservices}.Template` will package and publish.
- **CLI consumers**: `src/scaffold/init-new.ts`, `src/product-loop/sprint-runner.ts` (CB-1), `src/pil/layer3-ee-injection.ts`.

---

## Phase 1 — Server-side path canonicalization (EE)

### Goal

Collapse all BB intercepts under a single `project_slug = "muonroi-building-block"` regardless of host path prefix. Today `/api/stats?since=30d` shows 5+ separate project keys for the same repo, fragmenting retrieval scope.

### Risk

LOW — additive normalization at intercept ingress. Existing data stays; we add a derived `project_slug` field. Read path uses it when present, falls back to path.

### Tasks

- [ ] **1.1** — Add `canonicalizeProjectSlug(rawPath)` helper in `D:/sources/Core/experience-engine/lib/path-canonical.js`. Match patterns against `~/.experience/config.json:org.repoPatterns` (already includes `muonroi-building-block`). Strip host drive letter, normalize `/`, match last segment that hits a repoPattern → return slug. **Guard**: if `org.repoPatterns` absent or empty, return `null` AND log a warning once at server startup so Phase 1.5 backfill doesn't silently zero out everything.
- [ ] **1.2** — Wire `canonicalizeProjectSlug()` into `handleIntercept` (`server.js`). Add `payload.project_slug` if derivable. Keep raw `project` field for backwards compat.
- [ ] **1.3** — Update `handleStats` to bucket by `project_slug` when present, fall back to `project`. Add a `bySlug` field in response.
- [ ] **1.4** — Unit test in `D:/sources/Core/experience-engine/tests/path-canonical.test.js` covering: `D:/sources/Core/muonroi-building-block` → `muonroi-building-block`, `/d/Personal/Core/muonroi-building-block/src/X` → `muonroi-building-block`, `~/projects/storyflow_ui` → `storyflow_ui`, unknown path → `null`.
- [ ] **1.5** — Backfill migration script `scripts/backfill-project-slug.mjs`: scan existing intercepts, set `project_slug` where path matches. Dry-run flag, idempotent.
- [ ] **1.6** — Restart EE server (VPS). Verify via `curl /api/stats?since=30d` that BB entries collapse into 1-2 buckets max.

### Acceptance

`curl -sH "Authorization: Bearer $READ" "https://experience.muonroi.com/api/stats?since=30d"` returns `bySlug["muonroi-building-block"].intercepts >= 80` (sum of current 30+ buckets).

---

## Phase 2 — BB collection separation + dedup

### Goal

Carve out `bb-behavioral` and `bb-recipes` collections from the shared `experience-behavioral`. Retrieval for `/ideal` BB-context queries hits a focused namespace; duplicates (rule-engine entries have 3-4 near-identical copies) get merged.

### Risk

MEDIUM — wrong filter strips non-BB entries. Mitigate via dry-run + `project_slug` gate from Phase 1.

### Tasks

- [ ] **2.1** — Create collection `bb-behavioral` in Qdrant via EE server bootstrap (`server.js` `ensureCollections()`). Same vector dims as `experience-behavioral`. **CRITICAL**: also add `"bb-behavioral"` to the `KNOWN_COLLECTIONS` Set in `server.js`. Without this, `handleSearch` filter rejects the collection name and returns `{points:[]}` silently — Phase 5 will appear broken.
- [ ] **2.2** — Create collection `bb-recipes` (sample-as-recipe). Same dims. Add `"bb-recipes"` to `KNOWN_COLLECTIONS` as in 2.1.
- [ ] **2.2b** — **Rollback path**: if migration in 2.3 fails mid-flight, script must support `--rollback` flag that deletes the `bb-behavioral` + `bb-recipes` collections AND clears the `KNOWN_COLLECTIONS` additions from a state file (`scripts/.split-bb-state.json`). Re-runnable from scratch.
- [ ] **2.3** — Migration script `scripts/split-bb-behavioral.mjs` — scrolls `experience-behavioral`, copies points where `payload.project_slug === "muonroi-building-block"` OR text contains BB markers (`[MExtractAsRule]`, `MDbContext`, `MTokenInfo`, `IRule<TContext>`, `RuleResult`, `MRepository`, `Muonroi.`) into `bb-behavioral`. Source points remain (no destructive delete). Dry-run + report mode first.
- [ ] **2.4** — Dedup pass: within `bb-behavioral`, group points whose `text` normalized (lowercase, strip punctuation) cosine similarity ≥ 0.97 → keep highest `evidence` count, mark others `archived: true` in payload (do NOT delete).
- [ ] **2.5** — Confirm `handleSearch` honors `body.collections: string[]` (plural array — existing API). If a bug is found where filter is dropped, fix in `server.js`. No new API surface needed.
- [ ] **2.6** — Verify: `curl POST /api/search -d '{"query":"MExtractAsRule","collections":["bb-behavioral"],"limit":5}'` returns only `bb-behavioral` hits, no `experience-behavioral` cross-leak. Note plural `collections` and array form.

### Acceptance

`bb-behavioral` has 50–200 points (dedup'd from current scattered ~300+ across behavioral). Search filter actually narrows when `collections: ["bb-behavioral"]` is passed. `KNOWN_COLLECTIONS` updated. `experience-behavioral` size unchanged (non-destructive migration). Rollback flag works end-to-end on a staging instance.

---

## Phase 3 — Targeted backfill from BB structured assets

### Goal

Lift the structured docs (`REPO_DEEP_MAP.md`, `OSS-BOUNDARY.md`, `samples/`, `schema/`) into EE collections. Closes the gaps surfaced by the probe (Observability, DecisionTable/FEEL, Mediator, Resilience, gRPC, SignalR, BFF, Secrets — currently weak coverage <0.65).

### Risk

LOW — pure additive, no migration. Wrong chunking just means lower retrieval quality; iteration is cheap.

### Tasks

- [ ] **3.1** — Build parser for `REPO_DEEP_MAP.md` in `scripts/ingest-bb-to-ee.mts` (muonroi-cli repo). Walk H3 sections per package, parse markdown tables → per-row point with text = `<file>: <class> — <key-methods>`, payload `{package, file, project_slug: "muonroi-building-block", source: "repo-deep-map"}`. Target collection `bb-behavioral`.
- [ ] **3.2** — Parse `BB/README.md §Package Families` table → for each row emit a high-level point `<package> — <intent (header-derived)> — license: <OSS|Commercial>` into `experience-principles` collection (these are decision-table-grade rules).
- [ ] **3.3** — Parse `BB/OSS-BOUNDARY.md` matrix → emit hard-rule points into `experience-principles` flagged `severity: high`. Each rule of form `OSS package <X> MUST NOT reference commercial package <Y>`. These drive PreToolUse hints in Phase 7.
- [ ] **3.4** — Parse `BB/samples/*/README.md` → for each sample emit 1 point to `bb-recipes` with `text = "<sample intent>: uses <packages>", payload {sample_dir, packages: [...], intent_keywords: [...]}`. Intent keywords parsed from H1/H2 + first 200 words.
- [ ] **3.5** — Parse `BB/schema/*.json` filenames + `$schema` description → emit 1 point per schema to `bb-behavioral` payload `{schema_path, fields_count}`.
- [ ] **3.5b** — **Template intent ingestion**: for each of `D:/sources/Core/Muonroi.{BaseTemplate,Modular.Template,Microservices.Template}/`, parse `README.md` (intent + when-to-use) + `.template.config/template.json` (symbols/choices + `description`) + `AGENTS.md` (if present, agent guidance has good intent signals) + scan `*.csproj` for BB package references → emit 1 high-quality point per template to `bb-recipes` with payload `{template_name, shortName, nuget_id, intent_keywords, packages_consumed}`. These are the primary scaffold targets — Phase 5 retrieval depends on these existing. Skip `REPO_DEEP_MAP.md` (templates don't ship that file today).
- [ ] **3.6** — Idempotency: each point gets a deterministic id `sha256(source + text).slice(0, 32)`. Re-running the script upserts, does not duplicate.
- [ ] **3.7** — Hash-watch: write `D:/sources/Core/muonroi-cli/.ee-ingest-state.json` with SHA of each source file. Re-run only re-ingests changed sources.
- [ ] **3.8** — CLI `bun run scripts/ingest-bb-to-ee.mts --bb-root D:/sources/Core/muonroi-building-block --templates-root D:/sources/Core --dry-run` prints what would change; without `--dry-run` does the POST. `--templates-root` discovers sibling repos `Muonroi.*.Template` / `Muonroi.BaseTemplate` for 3.5b.
- [ ] **3.9** — **Auth token resolution**: script reads `EE_AUTH_TOKEN` from env first; if absent, reads `~/.experience/config.json:serverAuthToken`. Errors out with a clear hint pointing at both sources if neither resolves. Document in script header comment.

### Acceptance

Probe queries from the 2026-05-15 coverage report now return `bb-*` collection hits with score ≥0.70 for: "decision table FEEL", "observability tracing", "muonroi mediator", "muonroi resilience polly". Sample retrieval: `"fraud detection"` returns `samples/FraudDetection` as top hit.

---

## Phase 4 — CLI ingestion script polish

### Goal

The ingestion script from Phase 3 is the production entry point. Make it CI-ready, scheduled, and observable.

### Risk

LOW.

### Tasks

- [ ] **4.1** — Add `--collection-filter` flag to ingest only a subset (e.g., `--collection-filter bb-recipes`).
- [ ] **4.2** — Stderr summary: `✓ ingested N new, M updated, K unchanged in bb-behavioral`.
- [ ] **4.3** — Exit code 1 on any POST failure; offline queue is OK (CLI doesn't need its own queue — EE thin client already has one for the agent path, but this script targets the server directly).
- [ ] **4.4** — Add npm script `"ee:ingest-bb": "bun run scripts/ingest-bb-to-ee.mts"` in root `package.json`.
- [ ] **4.5** — `.github/workflows/ee-ingest-bb.yml` — runs nightly + on push to `master` of `muonroi-building-block` (if that repo has a webhook). Secret: `EE_AUTH_TOKEN`.
- [ ] **4.6** — Unit test for parser in `tests/ee-ingest/parser.spec.ts` against a fixture deep-map snippet.

### Acceptance

`bun run ee:ingest-bb --dry-run` on a fresh clone reports `0 unchanged` if Phase 3 ran before, or full N points if not. Re-run idempotent.

---

## Phase 5 — `/ideal` CB-1 BB-aware retrieval

### Goal

Before `sprint-runner` enters CB-1 (intent → council → spec), if the target project resolves to BB, query `bb-recipes` + `bb-behavioral` top-k and inject the result into the council system prompt.

### Risk

MEDIUM — retrieval inject increases prompt size; must respect token budget. Council convergence may shift; capture before/after dispersion in a fixture.

### Tasks

- [ ] **5.0** — **Extend type first**: add `targetFramework?: "muonroi-building-block" | string` to `IntentDetectionTrace` in `src/pil/types.ts`. Without this, 5.1 won't typecheck.
- [ ] **5.1** — Detect "BB target" in `src/scaffold/init-new.ts` and `src/scaffold/point-to-existing.ts` — heuristic: presence of `Directory.Build.props` + `*.sln` + any `src/Muonroi.*` directory → set `IntentDetectionTrace.targetFramework = "muonroi-building-block"`.
- [ ] **5.2** — Add `src/ee/bb-retrieval.ts` exposing `fetchBBContext(prompt, opts) → { recipes, behavioralRules, packages }`. Calls `/api/search` 3x with `collections: ["<name>"]` (plural array), parallel. Total ≤ 800ms with retry-once. **Graceful degrade**: on network failure or 4xx/5xx, return empty result and log once — never block `/ideal`.
- [ ] **5.2b** — **Empty-collection guard**: if `bb-recipes` query returns zero hits (Phase 3 didn't run yet, or no recipe matches), skip recipe injection but still emit behavioral rules. Log a one-line `[ee.bb] no recipe hits — running Phase 3 ingestion would help` to stderr.
- [ ] **5.3** — Inject BB context into council system prompt at the CB-1 entry point in `src/product-loop/loop-driver.ts` (NOT `src/product-loop/index.ts` — that file dispatches to the loop-driver). Inject BEFORE the council debate fires, inside the gather/scoping FSM, when `IntentDetectionTrace.targetFramework === "muonroi-building-block"`. Format:
  ```
  ## BB context (retrieved from Experience Engine)
  Closest sample(s): samples/FraudDetection (matches intent: fraud)
  Packages to consider:
  - Muonroi.RuleEngine.Core (OSS) — annotate rules with [MExtractAsRule]
  - Muonroi.Tenancy (OSS) — multi-tenant context isolation
  Behavioral rules:
  - Use AddRuleEngine<TContext>() with AddRulesFromAssemblies()
  ```
- [ ] **5.4** — Budget guard: inject max 1500 tokens of BB context. If retrieval returns more, take top-k by score.
- [ ] **5.5** — Telemetry: emit `ee.bb-retrieval.hits`, `ee.bb-retrieval.latency_ms` via existing `src/pil/metrics.ts` if present, else stderr behind `--debug-ee`.
- [ ] **5.6** — E2E spec `tests/harness/bb-aware-ideal.spec.ts` — mock EE responses, drive `/ideal "build fraud detection"`, assert injection happened (snapshot the system prompt).
- [ ] **5.7** — Feature flag: `userSettings.eeBBContext: true|false` (default true). Allows opt-out without code change.
- [ ] **5.8** — **De-dup with sibling plan's Layer 3 injection**: `bb-retrieval.ts` injects explicit BB context into the council system prompt at CB-1. Sibling plan's Layer 3 (`src/pil/layer3-ee-injection.ts`) injects EE hits at every LLM call with score ≥0.55. If a BB entry scores ≥0.55 on a later turn, it could double-inject. Mitigation: stamp injected BB context with a marker `<!-- bb-context-injected:<sha> -->`.
- [ ] **5.8a** — **Implement marker-check in Layer 3**: edit `src/pil/layer3-ee-injection.ts` to scan `ctx.enriched` for `<!-- bb-context-injected:` prefix before appending each EE hit. Skip any hit whose payload sha matches an already-present marker. Without this code change, 5.8 is documentation-only and double-injection still occurs (low risk: context bloat, not break). Acceptance: unit test in `tests/pil/layer3-bb-dedup.spec.ts` verifies skip happens.
- [ ] **5.8b** — Document the marker contract in `src/ee/bb-retrieval.ts` header and `src/pil/layer3-ee-injection.ts` header (both sides reference each other so future maintainers don't accidentally regress).

### Acceptance

Manual: `/ideal "build fraud detection service"` in a fresh `init-new` scaffold shows in `--debug-ee` output that `samples/FraudDetection` was retrieved as top recipe and injected. Spec passes deterministically against the mock.

---

## Phase 6 — `init-new.ts` template-aware scaffold

### Goal

Replace "clone full BB → 60+ packages dumped into `<name>/server/`" with "use BB's own published `dotnet new` templates, then cherry-pick packages by EE-recommended intent".

### Template scope (out-of-band)

Three production `dotnet new` template repos live as **siblings of BB**, each with its own git remote:
- `D:/sources/Core/Muonroi.BaseTemplate/` — Clean/Onion starter
- `D:/sources/Core/Muonroi.Modular.Template/` — Modular Monolith
- `D:/sources/Core/Muonroi.Microservices.Template/` — Microservices + YARP gateway

They are currently behind BB main. **The user owns the upgrade in a separate session — this plan does NOT block on it.** Phase 6 treats whichever version is published as a **black box**: the CLI installs the templates as-is via `dotnet new install <pkg>`, scaffolds, then applies the BB ecosystem on top.

The scaffold quality bar is **"output looks like a senior BB developer wrote it"**, measured objectively in 6.acceptance below.

### Risk

**HIGH** (revised up from MEDIUM per review). Concrete hazards:
1. `InitNewOptions` interface today is `{ targetDir, projectName, beSource, feStack, ... }` — adding `bbTemplate?` + `eePackages?` is a breaking type change that ripples into the TUI form-card + caller in `src/ui/app.tsx`.
2. `InitNewResult.files` currently tracks plain text files. `Directory.Packages.props` is XML/MSBuild — injection requires a real parser (e.g., `fast-xml-parser`), not string concatenation, or the file may load in Visual Studio but fail at `dotnet restore`.
3. Template `shortName` vs NuGet package name: each template repo's `.template.config/template.json` has its own `shortName` that `dotnet new` registers. CLI must read these shortNames at install time (parse `template.json` in each repo) and pass them to `dotnet new <shortName>` — do NOT hardcode based on NuGet package name.
4. Templates currently outdated vs BB main (user upgrading in a separate session) — Phase 6 CLI code must work against whatever version is published. Treat template as black box; apply BB ecosystem layer on top.

Fallback path = current clone. Detect via `which dotnet` + `dotnet new list` parsing for the three template shortNames (auto-discovered from `template.json` post-install).

### Tasks

- [ ] **6.1** — Detect `dotnet` SDK in `src/scaffold/init-new.ts` (`spawnSync("dotnet", ["--version"])`).
- [ ] **6.2** — Detect BB templates installed: `dotnet new list` and grep for the three shortNames registered by `Muonroi.{Base,Modular,Microservices}.Template`. If any absent, run `dotnet new install Muonroi.BaseTemplate Muonroi.Modular.Template Muonroi.Microservices.Template` (NuGet) — pin versions in CLI config. Gracefully skip install if NuGet feed unreachable → fall back to clone path.
- [ ] **6.2a** — **Template picker UX (decision: explicit pick, EE hints)**: extend `init-new-form-card.tsx` with a step after FE-stack selection: show 3 templates (BaseTemplate / Modular / Microservices) as arrow-key choices. Show "⭐ recommended for your intent" badge next to the EE top-recipe match (if any). User confirms with Enter. No auto-pick. Reason: senior workflow expects an explicit architectural decision.
- [ ] **6.2b** — **Type extension** in `src/scaffold/init-new.ts`: extend `InitNewOptions` with `bbTemplate: { shortName: string, nugetId: string, version: string }` and `eePackages?: string[]`. Update caller in `src/ui/app.tsx`. Keep backward-compat: if `bbTemplate` absent → current clone path.
- [ ] **6.2c** — Add dependency `fast-xml-parser` (or equivalent — confirm it's already in `package.json` first). Used by 6.3 to safely round-trip `Directory.Packages.props`.
- [ ] **6.3** — Refactor scaffold flow:
  ```
  if (dotnet-available && bb-template-available) {
    dotnet new muonroi-service -n <name> -o <target>/server
    parse Directory.Packages.props via fast-xml-parser
    add <PackageVersion> entries for EE-recommended packages
    write back, verify with `dotnet restore --nologo`
  } else {
    fallback: git clone BB into <target>/server (current behavior)
  }
  ```
  **Verification step**: after injection, run `dotnet restore --nologo` in scaffolded dir. If exit ≠ 0, roll back the file and fall back to clone path.
- [ ] **6.4** — Package recommendation comes from Phase 5 retrieval. Filter to OSS-only by default; require explicit `--commercial` flag to add commercial packages (gated by `LICENSE-COMMERCIAL` check).
- [ ] **6.5** — Emit `<target>/server/EE-INTENT.md` recording: intent prompt, picked template, EE-recommended packages, retrieval score, **coverage status** (`full` if all recommended packages have EE coverage ≥0.70, else `partial` with list of weak-coverage packages). Used for future `/ideal --resume` runs.
- [ ] **6.6** — Update `init-new-form-card.tsx` to show "Template: Muonroi.{Base|Modular|Microservices}.Template" + "Coverage: full / partial" once scaffold completes.
- [ ] **6.7** — Spec `tests/harness/init-new-bb-template.spec.ts` — mock both dotnet-available + dotnet-absent paths.

### Code-gen sub-phase (senior-bar wiring)

After `dotnet new` + package injection (tasks 6.1–6.4), the CLI applies the BB ecosystem on top of the scaffolded template. This is what makes the output indistinguishable from a senior BB dev's work.

- [ ] **6.8** — **`Program.cs` wiring generator** in `src/scaffold/bb-ecosystem-apply.ts`: regex-based injection only (no C# AST parser — `tree-sitter-c-sharp` is NOT in `package.json` and adding it is out of scope). Locate `var builder = WebApplication.CreateBuilder(args);` line as the anchor; inject `builder.Services.AddInfrastructure(builder.Configuration, new MTokenInfo(...))` + `app.UseDefaultMiddleware()` after it. For rule-engine intents, append `builder.Services.AddRuleEngine<TContext>(); builder.Services.AddRulesFromAssemblies(typeof(Program).Assembly);`. Each injection is wrapped with a sentinel comment for idempotency: `// >>> muonroi-cli:injected:bb-ecosystem` / `// <<< muonroi-cli:injected:bb-ecosystem`. Skip injection if the sentinel is already present in the file.
- [ ] **6.9** — **Sample rule generator** for rule-engine intents: write `<target>/server/src/<Project>.Domain/Rules/Sample<Intent>Rule.cs` with `[MExtractAsRule("CODE", DependsOn = new[]{...})]` attribute + skeleton `EvaluateAsync` body that returns `RuleResult.Passed()` and a TODO comment. Match the convention from EE retrieval top-hit.
- [ ] **6.10** — **Sample test generator**: write `<target>/server/tests/<Project>.UnitTests/Rules/Sample<Intent>RuleTests.cs` with one passing test asserting `RuleResult.Passed()`. Senior-grade test: uses `FactBag` + reflection-free context construction.
- [ ] **6.11** — **`Directory.Packages.props` minimalism**: cross-reference template's existing `<PackageVersion>` entries with EE-recommended set + intent-required set. Remove any BB package not in either set (template may ship more than needed). Use `fast-xml-parser` from 6.2c.
- [ ] **6.12** — **Copy `check-modular-boundaries.ps1`** from BB repo into `<target>/server/scripts/` so the scaffolded project ships with the BB gate. Also wire it into `<target>/server/.github/workflows/ci.yml` if a workflows dir exists.

### Quality gate (retry-once + soft fallback)

- [ ] **6.13** — **Gate runner** in `src/scaffold/bb-quality-gate.ts`: after 6.8–6.12, sequentially run:
  1. `dotnet restore` (timeout 120s)
  2. `dotnet build -c Debug --nologo` (timeout 180s)
  3. `pwsh ./scripts/check-modular-boundaries.ps1 -RepoRoot .` (timeout 30s)
  4. AST grep verifying `AddInfrastructure`, `MDbContext` usage, `[MExtractAsRule]` presence (intent-dependent)
  
  Collect each step's stdout/stderr. Return `{ passed: boolean, failures: Array<{step, output}> }`.

- [ ] **6.14** — **Retry-once on failure**: if gate fails, call the council ONE more time at CB-1 with the gate failure output appended to the system prompt as `## Gate failures (please fix in next iteration)`. Re-run code-gen 6.8–6.12 with the corrected guidance. Run gate again.

- [ ] **6.15** — **Soft fallback after retry**: if gate still fails after retry, emit `<target>/server/EE-GATE-FAILURES.md` listing each failure step + output + remediation hints from EE behavioral rules retrieval (query `bb-behavioral` for keywords from failure stderr). DO NOT revert the scaffold. Print `⚠️ Scaffold complete with N gate failures — see EE-GATE-FAILURES.md. Run /ideal --resume to attempt fixes interactively.` User can iterate.

- [ ] **6.16** — Wire `/ideal --resume <project-path>` flag: detects `EE-GATE-FAILURES.md` at the given path, loads context, re-enters CB-1 with failures as initial prompt. **Note**: `point-to-existing.ts` is a pure path validator — it does NOT have a resume hook today. Implement resume orchestration from scratch in `src/scaffold/resume-from-gate-failures.ts`. Reuse `point-to-existing.ts` only for path validation; new file owns the CB-1 re-entry + context loading.

### Acceptance — "senior BB developer" bar

After `/ideal "build <intent>"` → user picks template (or CLI auto-recommends top match from `bb-recipes`) → scaffold + BB ecosystem applied, the output must pass ALL of:

1. **Compile**: `dotnet restore` + `dotnet build -c Debug` exit 0.
2. **BB convention gate**: `pwsh ./scripts/check-modular-boundaries.ps1` (copied from BB into scaffolded repo) exit 0 — no OSS→Commercial leak.
3. **Package minimalism**: `Directory.Packages.props` contains only EE-recommended packages for the intent, not all 60+ BB packages.
4. **DI wiring**: `Program.cs` has `AddInfrastructure(...)`, `UseDefaultMiddleware()`, plus intent-specific calls (e.g., `AddRuleEngine<TContext>()` for rule-engine intents) — verified by regex match against the sentinel block (`>>> muonroi-cli:injected:bb-ecosystem` / `<<< …`) AND that the block contains the required call names. No C# AST parser involved.
5. **Conventions present**: `MDbContext` used (not raw `DbContext`), `IMDateTimeService` injected (not `DateTime.Now`), `IMJsonSerializeService` for serialization. EE retrieval feeds these patterns into the council prompt at CB-1.
6. **Senior smoke**: scaffolded `samples/<intent>/` includes at least 1 sample rule with `[MExtractAsRule]` + matching unit test that passes.

Snapshot of acceptance run output goes in `docs/phase-g-snapshots/2026-05-15-bb-scaffold-smoke.txt` for regression baseline.

---

## Phase 7 — PreToolUse OSS-BOUNDARY hints

### Goal

The hard rules ingested in Phase 3.3 (OSS packages MUST NOT reference Commercial) become live PreToolUse hints when the agent edits a file that violates them.

### Risk

LOW — hint-only by default. Severity HIGH means the warning shows but does not block.

### Tasks

- [ ] **7.1** — Extend `~/.experience/rules/` with a new pattern file `bb-oss-boundary.json`:
  ```json
  {
    "trigger": { "tool": "Edit", "pathGlob": "**/Muonroi.*/**/*.cs" },
    "query": "OSS boundary {{detected_package}}",
    "collection": "experience-principles",
    "scoreFloor": 0.75
  }
  ```
- [ ] **7.2** — Extend PreToolUse hook to read this rule file (existing hook lives in EE thin-client — check `~/.experience/hooks/pre-edit.js`). If absent, gate this phase on first creating that file.
- [ ] **7.3** — Detect `detected_package` from path: regex `Muonroi\.([^/]+)/` → e.g., `Muonroi.RuleEngine.Core` → package name.
- [ ] **7.4** — Surface hint in agent context window as `⚠️ [Experience - High Confidence] OSS package X must not reference commercial Y` per existing hint format.
- [ ] **7.5** — Feedback path: `exp-feedback noise <pointId> bb-principles wrong_repo` available if hint fires outside BB.
- [ ] **7.6** — Smoke test: edit `src/Muonroi.RuleEngine.Core/Foo.cs` and add `using Muonroi.RuleEngine.CEP;` (CEP = commercial) → hint fires.

### Acceptance

Manual test confirms the hint appears. False-positive rate <10% on a 50-file random BB edit sample (gut check).

---

## Phase 8 — Verification + docs

### Tasks

- [ ] **8.1** — Update `D:/sources/Core/muonroi-cli/CLAUDE.md` with a "BB-aware /ideal" section pointing at this plan + key file paths.
- [ ] **8.2** — Update `D:/sources/Core/CLAUDE.md` REPO_DEEP_MAP table if EE config layout changed.
- [ ] **8.3** — Add `docs/agent-harness/EE-INGESTION.md` documenting the ingestion script + collection layout for future maintainers.
- [ ] **8.4** — Run the full coverage probe again post-Phase 3:
  ```
  for q in "decision table FEEL" "observability tracing" "fraud detection" "loan approval" "multi-tenant SaaS"; do
    curl POST /api/search -d "{\"query\":\"$q\",\"collection\":\"bb-recipes\",\"limit\":3}"
  done
  ```
  Snapshot results in `docs/phase-g-snapshots/2026-05-15-bb-ee-coverage.txt` for regression baseline.
- [ ] **8.5** — Add CHANGELOG entry under `[Unreleased] > Added`:
  ```
  - **/ideal × BB**: bb-recipes + bb-behavioral EE collections, template-aware
    scaffold via dotnet new muonroi-service, OSS-BOUNDARY pre-edit hints.
  ```

### Acceptance

All probes from §8.4 score ≥0.70 against `bb-*` collections. CHANGELOG entry in place. CLAUDE.md updated.

---

## Resolved decisions (2026-05-15)

| Decision | Value | Rationale |
|---|---|---|
| Template selection UX | **Explicit pick** with EE "recommended" badge | Senior workflow expects an architectural decision, not magic |
| BB ecosystem apply | **Full code-gen** (Program.cs wiring, sample rule, sample test, props minimalism, gate copy) | Hits the senior-bar acceptance criteria |
| Quality gate behavior | **Retry-once via council, then soft fallback** | Council debate already exists; reuses it. Soft fallback so user can iterate via `--resume` |
| Coverage threshold | **Accept degraded for v1** | `partial` coverage flagged in EE-INTENT.md; intents on weak-coverage packages (Observability, FEEL, Mediator, Resilience, Secrets, gRPC, SignalR, BFF) scaffold but warn. Backfill is a follow-up cycle. |

## Coverage tier policy

For Phase 5 retrieval and Phase 6 code-gen:

| Tier | Packages (per 2026-05-15 EE probe) | Scaffold behavior |
|---|---|---|
| **Strong (≥0.70)** | RuleEngine.{Core,Abstractions}, Tenancy, Auth, Caching.{Memory,Redis}, Data.EntityFrameworkCore, Governance.License | Full senior bar — code-gen + gate hard-enforced via retry-once |
| **Medium (0.55–0.70)** | DecisionTable, Hangfire/Quartz background, Messaging routing, Core helpers | Code-gen runs; gate failures still produce retry-once but accepted as soft fallback more readily |
| **Weak (<0.55 OR backfill missing)** | Observability/Tracing, FEEL specifics, Mediator, Resilience, Secrets, gRPC, SignalR, BFF | Scaffold proceeds but EE-INTENT.md flagged `coverage: partial`. Code-gen skips package-specific generators; only generic `AddInfrastructure` wiring lands. |

The tier is computed at runtime from the retrieval scores in 5.2, not hardcoded. The package lists above are seed expectations.

## Open questions

1. **Schedule for `ee:ingest-bb`**: nightly vs on-BB-commit webhook? Webhook requires gh app on BB repo — defer to user.
2. **Commercial gate**: should `/ideal` ever recommend commercial packages without `--commercial` flag, even if EE has higher-confidence hits? Default = no; reconsider after dogfooding.
3. **`Vue/Svelte` BB targets**: out of scope — BB is .NET only. Future plan if BB extends to Node/web.

## Effort estimate

| Phase | Effort | Owner |
|---|---|---|
| 1 — Path canonicalization | 0.5d | EE server (sub-agent) |
| 2 — Collection separation | 0.5d | EE server (sub-agent) |
| 3 — Targeted backfill (incl. 3 templates) | 1.0d | CLI (sub-agent) |
| 4 — Ingestion script polish | 0.5d | CLI (sub-agent) |
| 5 — CB-1 BB retrieval | 0.75d | CLI (sub-agent) |
| 6 — Template scaffold + ecosystem apply + code-gen + gate | 1.5d | CLI (sub-agent) |
| 7 — OSS-BOUNDARY hints | 0.25d | EE thin-client (sub-agent) |
| 8 — Verification + docs | 0.25d | Controller |
| **Total** | **~5.25d** CLI/EE wall clock | Mostly Sonnet sub-agents |

Template upgrade is user-owned in a separate session, **not on this critical path**. Parallelizable: Phase 1+2 (EE-side) ∥ Phase 3+4 (CLI ingestion). Phase 5–7 depend on 1–4 landing. Phase 8 last.

## References

- Sibling plan: `docs/superpowers/plans/2026-05-15-ideal-ee-native.md` (generic EE integration)
- EE coverage probe results: in this session, 2026-05-15
- BB structured assets: `D:/sources/Core/muonroi-building-block/{REPO_DEEP_MAP.md, README.md, OSS-BOUNDARY.md, samples/, schema/, templates/}`
- EE server: `D:/sources/Core/experience-engine/server.js`
- Thin-client: `~/.experience/{config.json, exp-feedback.js, hooks/, rules/}`
