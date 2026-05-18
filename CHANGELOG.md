# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING
- **harness**: `src/agent-harness/*` moved to `packages/agent-harness-{core,opentui}`.
  - Pure pieces (protocol, selector, predicate, driver, registry, mock-llm, idle,
    spec-helpers, sidechannel transport, mcp-server, lint) now live in
    `@muonroi/agent-harness-core`.
  - OpenTUI-specific pieces (`<Semantic>`, `<SemanticProvider>`,
    `reconciler-hook`, `input-bridge`, `agent-mode`) live in
    `@muonroi/agent-harness-opentui`.
  - A backwards-compat shim at `src/agent-harness/index.ts` still re-exports both.
  - **Migration**: rewrite `from "./agent-harness/<x>"` →
    `from "@muonroi/agent-harness-core/<x>"` (pure) or
    `from "@muonroi/agent-harness-opentui"` (OpenTUI). The shim works for
    deep imports but direct subpath imports are clearer.
- **product-loop**: CB-3 (verify-recipe halt) now `yields` a structured
  `{ type: "halt", reason, recovery_options }` chunk instead of `throw`.
  All 3 `runSprint()` call sites in `src/product-loop/index.ts` have been
  updated to handle the halt chunk. **Migration**: callers consuming
  `runSprint()` must add `if (chunk.type === "halt") { … }` inside their
  `for await` loops.

### Added
- **`/ideal` × BB ecosystem**: scaffold flow now injects Experience Engine
  context at CB-1 when the target resolves to `muonroi-building-block`.
  - New EE collections `bb-recipes` (sample + template intents, 9 points)
    and `bb-behavioral` (BB rules + REPO_DEEP_MAP + schemas, 596 points).
  - `experience-principles` extended with 46 OSS-BOUNDARY hard rules +
    Package Families decision table — drives PreToolUse hints automatically
    via the existing semantic-retrieval interceptor (no static rule file
    needed).
  - `src/ee/bb-retrieval.ts` — `fetchBBContext` queries the three
    collections in parallel with retry-once + graceful degrade + 1500-token
    budget. Marker-stamped output for Layer 3 dedup.
  - `src/scaffold/bb-ecosystem-apply.ts` — applies Program.cs wiring,
    sample rule + test, `Directory.Packages.props` minimalism, and copies
    `check-modular-boundaries.ps1` into the scaffold.
  - `src/scaffold/bb-quality-gate.ts` — `dotnet restore`/`build` +
    modular-boundaries gate + sentinel-regex DI verification with
    retry-once via council and soft-fallback `EE-GATE-FAILURES.md`.
  - `/ideal --resume <project-path>` — re-enters CB-1 with gate failures
    as context (`src/scaffold/resume-from-gate-failures.ts`).
  - New endpoint `POST /api/ingest-point` on EE for structured-point
    backfills (embeds via `getEmbeddingRaw`, upserts to Qdrant directly,
    gated by `KNOWN_COLLECTIONS`).
  - Path canonicalization (`lib/path-canonical.js`) collapses
    `D:/sources/`, `/d/Personal/`, `~/projects/...` into stable
    `project_slug` values; `/api/stats` now reports `bySlug` counts.
  - Feature flag `userSettings.eeBBContext: false` to disable.
  - Docs: `docs/agent-harness/EE-INGESTION.md`.
- **harness packages** (new):
  - `@muonroi/agent-harness-react` — React DOM adapter. Bundle gzip:
    346 B (harness OFF, tree-shaken via compile-time `__MUONROI_HARNESS__`
    define) / 914 B (ON). Peer-deps `react@>=18`, `react-dom@>=18`.
  - `@muonroi/agent-harness-angular` — Angular 16+ adapter.
    `[muonroiSemantic]` directive with `@Optional() @SkipSelf() @Host()`
    element-injector DI. SSR-safe via `isPlatformBrowser` guard. Bundle
    gzip ≤ 8 KB.
- **harness-core**:
  - `createWebSocketTransport({ url, token })` — browser-safe WebSocket
    transport with Zod-validated envelope (`dir: "frame" | "event" | "cmd"`).
  - `"browser"` export condition strips Node-only modules.
  - `HarnessSpawn` injection contract — `createMcpHarnessServer({ spawn })`
    accepts a caller-provided spawn closure so core no longer back-imports
    `src/`.
- **/ideal recovery flow**:
  - HaltRecoveryCard rendered when CB-3 yields a halt chunk
    (`<Semantic id="ideal-halt-card" role="dialog" isModal>`).
  - Init-new flow scaffolds a project: `<name>/server/` (clone of
    `muonroi-building-block`) + `<name>/client/` (React/Angular/none) with
    `<SemanticProvider>` wired.
  - Point-to-existing flow validates a path + re-detects the verify recipe.
  - Continue-as-council flow writes `spec.md` via injected council stream
    (no CB-3 re-entry).
- **docs**: `docs/agent-harness/TRANSPORTS.md` (fd 3/4, named-pipe, and
  WebSocket envelope spec), `docs/agent-harness/MONOREPO.md`
  (Bun-workspaces decision), per-package READMEs for all four packages.

### Security
- Pre-commit secret scanner (`scripts/check-secrets.mjs`) blocks `.claude/`,
  `.env*`, `user-settings.json`, and inline credential patterns (Anthropic,
  OpenAI, xAI, Google, AWS, GitHub tokens) before they enter git history.

### Changed
- **router**: `RouteDecision.provider === ""` is now expressed as
  `PROVIDER_INHERIT` from `src/router/provider-sentinel.ts`. Reads gated
  through `isInheritProvider()` helper. Behavior unchanged; coupling with
  `constrainToProvider()` made explicit and grep-able.
- **step-router (SAMR)**: requires BOTH `stepRouter.enabled=true` in
  user-settings AND `MUONROI_STEP_ROUTER_ACK=1` env var. Without the
  env-ack, enabled silently degrades to false and a one-time warning is
  printed (acknowledges SDK compatibility caveats — see module header).

### Added
- **storage**: `sweepStaleAtomicTemps(dir, maxAgeMs, depth)` removes
  orphaned `.{pid}.{hex}.tmp` files older than 24h on boot. Best-effort,
  swallows errors. Wired into `loadConfig()`.
- **dev workflow**:
  - `.husky/commit-msg` enforces Conventional Commits via
    `scripts/check-commit-msg.mjs` (rejects vague titles like "add fix",
    "addition advance SEO", "wip").
  - `.github/pull_request_template.md` requires risk level, test coverage,
    hidden-coupling notes, rollback plan.
  - `docs/branch-protection.md` documents required GitHub branch-protect
    settings; `scripts/setup-branch-protection.sh` applies them via `gh`.

- Multi-model council with adversarial debate (`/council`) — dynamic prompts, convergence detection, leader synthesis
- Role-based model routing — PIL task type maps to roles (leader/implement/verify/research), auto-routes to configured model
- Auto-compact after every turn — silent context compression keeps token costs flat across long sessions
- Auto-council trigger — `plan`/`analyze` tasks with high confidence automatically run multi-model debate
- Per-provider API key loading from settings.json — `providers.{name}.apiKey` fallback in keychain
- Prefix-based provider detection — models not in static catalog detected by ID prefix (deepseek-*, gpt-*, grok-*, etc.)
- `councilRounds`, `autoCouncil`, `autoCompactAfterTurn`, `roleModels` user settings
- Dedicated grep tool powered by npm ripgrep WASM (#263)
- `/btw` command for side questions (#264)

### Changed
- Switched Telegram voice/audio transcription from whisper.cpp to Grok STT (`/v1/stt`); removed `whisper-cli`, `ffmpeg`, and model-download requirements (#266, #265)
- Install script warns when auto-resolving to a pre-release version (#269)
- Release workflow publishes Sigstore build-provenance attestations (#271)

### Fixed
- Vision proxy now loads SiliconFlow API key from settings.json (previously only checked keychain + env var)
- Provider switching no longer reuses wrong API key when routing to a different provider
- RC version tags are published as GitHub prereleases (#268)

## [1.1.5-rc5] - 2026-04-15

### Fixed
- Pipe MCP stdio server stderr to prevent logs bleeding into TUI (#259)

## [1.1.5-rc4] - 2026-04-11

### Added
- Per-mode default models via `modeModels` in user settings (#258)

## [1.1.5-rc3] - 2026-04-09

### Added
- LSP support with server catalog and diagnostics (#255)

## [1.1.5-rc2] - 2026-04-07

### Added
- x402 payment protocol support via AgentKit (#252)
- Brin.sh security scanning for x402 payments (#253)

## [1.1.5-rc1] - 2026-04-05

### Added
- Programmable hooks system with 17 lifecycle events (#248)

## [1.1.4] - 2026-04-05

### Added
- Binary release workflow, install script, and self-management CLI commands (#241)
- Auto-open generated images and videos in the default OS viewer (#244)

### Changed
- Verify command (#240)

### Fixed
- Unbound `tmp_dir` variable error in install script (#242) (#243)

## [1.1.3] - 2026-04-01

### Added
- @-mention file autocomplete (#236)

## [1.1.2] - 2026-04-01

### Added
- Switch computer sub-agent to agent-desktop (#233)

### Removed
- Tracked telegram pair code from repo (#234)

## [1.1.1] - 2026-04-01

### Added
- Verify workflow with sandboxed testing and browser smoke checks (#228)
- Batch mode for headless Grok CLI runs (#231)

## [1.1.0] - 2026-03-26

### Added
- CLI update checker (#223)

### Changed
- Replace commit scan with PR security scan (#224)

### Fixed
- Issue with schedule modal (#226)

## [1.0.0-rc7] - 2026-03-26

### Added
- Scheduled headless runs with daemon and agent tools (#214)
- Shuru sandbox mode for agent shell execution (#215)
- Configurable sandbox settings (network, resources, ports, secrets) (#217)

## [1.0.0-rc6] - 2026-03-24

### Added
- Telegram file attachments — `telegram_send_file` tool for uploading media to Telegram chats (#212)
- Telegram voice/audio transcription via local whisper.cpp with auto model download and ffmpeg conversion (#210)
- Built-in Vision sub-agent for image validation through xAI Responses API (#209)
- Grok media tools (#207)
- Changelog (#206)

### Changed
- Updated app UI (#206)
- Clarify terminal support and unofficial status (#204)

### Fixed
- Mirror Telegram tool activity in TUI (#202)

## [1.0.0-rc5] - 2026-03-23

### Fixed
- Only send reasoningEffort for grok-3-mini (#200)

## [1.0.0-rc4] - 2026-03-23

### Added
- Support for multi-agent Grok models (#197)
- Custom sub-agents with /agents TUI and reliable interrupt (#192)
- Loading animation on streaming (#190)

### Changed
- Clarify headless json output format

## [1.0.0-rc3] - 2026-03-22

### Added
- JSON output mode for headless runs (#185)
- Test helper coverage for rewrite utilities (#184)
- Compaction (#183)
- Support for review command (#182)

### Fixed
- Use package.json version instead of hardcoded "1.0.0" (#188)

### Removed
- Grok.md support (#181)

## [1.0.0-rc2] - 2026-03-20

### Fixed
- Lint issues (#180)

### Changed
- Asset link in README.md
- Image source link in README.md (#179)
- Readme and version (#178)

## [1.0.0-rc1] - 2026-03-20

Initial release.