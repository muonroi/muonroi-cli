# Verification Plan — 30 Tasks (Basic → Advanced)

> Purpose: grade muonroi-cli on two axes — **feature completeness** and **adherence to the CLI's design mindset** — by dogfooding real tasks against the real `core/*` ecosystem repos.
> Generated 2026-06-15 from an evidence-grounded sweep of `src/ui/slash/*`, `src/index.ts`, `src/product-loop/*`, `src/pil/*`, `src/scaffold/*`, `src/ee/*` and every `core/*` REPO map.

## Grading rubric

For each task record two verdicts:

- **Completeness** — does the feature run end-to-end without crashing / missing artifacts? `PASS / PARTIAL / FAIL`
- **Mindset** — does it *behave* the way the pillar says it should (not just "produce output")? `PASS / PARTIAL / FAIL`

A task only counts as green when **both** are PASS.

## Mindset pillars (the grading axes)

| # | Pillar | Means |
|---|--------|-------|
| P1 | Council deliberation for complex tasks | Hard problems route to multi-model adversarial debate before code (`src/council/debate.ts`) |
| P2 | PIL progressive enrichment + role routing | 6-layer pipeline detects task type, enriches, routes to leader/implement/verify/research |
| P3 | Product Ideal Loop FSM (idea→ship) | `/ideal` staged state machine: discover→gather→research→scoping→approved + sprint CB gates |
| P4 | BB-aware scaffolding | BB target → BB recipes injected into council prompt at CB-1 before debate |
| P5 | EE recall-first learning | Query the brain before risky steps; close the loop with feedback |
| P6 | Zero-hardcode model/provider IDs | Everything from `catalog.json` + settings + runtime detection; else throw |
| P7 | Evidence-first, no guessing | Claims backed by read files / command output / test runs |
| P8 | Self-verifying TUI harness | UI changes driven as a real user via semantic tree + events (Tier1/Tier2) |
| P9 | Cost-flat auto-compaction | Context compacted every turn (pin survival, B3/B4 compactors, dedup); peaks under caps |
| P10 | Security audit + permission modes | safe/auto-edit/yolo + shuru sandbox emit always-on audit events |
| P11 | Pre-push full-suite test gate | No push lands on a red suite — full suite 0-failed |

---

## Tier 1 — Basic (1–10): single-turn, read-only / single-file, fast & cheap

| # | Subject | Repo | Feature | Run | PASS signal | Pillars |
|---|---------|------|---------|-----|-------------|---------|
| 1 | Boot-only CI smoke | muonroi-cli | `--smoke-boot-only` | `bun run src/index.ts --smoke-boot-only` | Exit 0, no keychain access; config+usage load; smoke line printed | P7 |
| 2 | Headless single-prompt ping | muonroi-cli | `-p` + `--format` | `bun run src/index.ts -p "Reply with exactly: PONG" -m "deepseek-ai/DeepSeek-V4-Flash" --format text` | stdout = `PONG`, plain text, no respond_* scaffold leak, exit 0 | P2 |
| 3 | Model catalog listing | muonroi-cli | `models` | `bun run src/index.ts models` | All models catalog-derived (provider+tier); no literal IDs | P6 |
| 4 | Doctor health checks | muonroi-cli | `doctor` | `bun run src/index.ts doctor` | Concrete PASS/FAIL per dep (dotnet/bun/EE/keychain); missing tools named | P7 |
| 5 | Explain BB rule-engine | muonroi-building-block | plain explain | `bun run src/index.ts -p "Explain the rule-engine: IRule, FactBag, RuleOrchestrator, how an [MExtractAsRule] rule is discovered+executed. Cite file paths." --format text` | Natural markdown (no respond_analyze wrapper), names real files, no invented APIs | P7, P2 |
| 6 | Next-prompt route decision | muonroi-cli | `/route` | `/route fix a flaky unit test in src/pil/__tests__/discovery.test.ts` | Prints tier/model/provider + one-line reason; catalog-resolved | P2 |
| 7 | Cost breakdown | muonroi-cli | `/cost` | `/cost` | Renders provider/model/tier/tokens/USD; works with no active run | P9 |
| 8 | Sprint status (no run) | muonroi-cli | `/status` | `/status` | Clean empty-state (no backlog/sprint-plan) — no throw | P3 |
| 9 | Hot-path /ideal one-liner | muonroi-cli | `/ideal` hot-path | `/ideal build a tiny CLI that prints the current UTC time as ISO-8601` | route-decision `path=hot-path forceCouncil=false`; `runLoopDriver` NOT called; sprintsRun=1 | P3, P2 |
| 10 | PIL enrichment table | muonroi-cli | `/optimize` | `/optimize why does the council clarifier never run in the sprint planning path?` | Layer-by-layer enrichment table + token-savings; classified informational | P2, P9 |

## Tier 2 — Intermediate (11–20): multi-file / one full sprint / harness drive

| # | Subject | Repo | Feature | Run | PASS signal | Pillars |
|---|---------|------|---------|-----|-------------|---------|
| 11 | Council on a design fork | muonroi-cli | `/council` | `/council 2 Should the existing-repo bypass in src/product-loop/index.ts also hot-path complexity=high changes?` | 2 rounds, council-step/speaker events per role; synthesis cites `index.ts:161-175`, not speculation | P1, P7 |
| 12 | Grounded clarification askcard | muonroi-ui-engine | discovery clarifier | `bun run src/index.ts "add a feature to the ui-engine"` | ≤3 model askcards, each with MODEL RECS (rec pre-selected) + "Other" tail; scoped variant → 0 cards | P2, P7 |
| 13 | No-clarify suppression | experience-engine | discovery no-clarify gate | `bun run src/index.ts "fix the recall scope-filter in experience-core.js, don't ask — just do it"` | 0 askcards, accepted=true, interviewed=false; proceeds straight to work | P2 |
| 14 | Scaffold small project | muonroi-cli | `/ideal --force-council` | `/ideal --force-council build a Node TS lib that validates ISO-4217 currency codes with vitest tests` | route-decision `path=council`; `runLoopDriver` called; advances discover→gather→...→approved | P3, P1 |
| 15 | Optimize a real impl turn | muonroi-cli | `/optimize` | `/optimize add a unit test for MBuildRenderPlan() in muonroi-ui-engine adapters.ts` | Layer table routes to STANDARD implement/verify directive; respond_* empty; non-zero savings | P2, P9 |
| 16 | EE recall + feedback loop | experience-engine | `/ee` + MCP | `/ee search recall scope-filter scoring path` → `/ee context on` | Ranked `[id col]` handles; pending-feedback ledger gates next recall; `noise` w/o reason → `reason_required`; `followed` clears | P5, P7 |
| 17 | Drive TUI via MCP | muonroi-cli | `mcp-driver` | `bun run src/index.ts mcp-driver` → `tui.start` → `tui.type "/cost"` → `tui.press Enter` → `tui.query 'id=status'` | tui.* advertised; named-pipe spawn (no windows_unsupported); out-of-allowlist argv → `argv_rejected` | P8, P10 |
| 18 | Usage report by callsite | muonroi-cli | `usage report` | `bun run src/index.ts usage report --by callsite --breakdown --json` | Valid JSON grouped by callsite; no crash on empty log | P9, P7 |
| 19 | Pin survives compaction | muonroi-cli | `/pin`+`/compact`+`/expand` | `/pin last` → `/compact` → `/pins` → `/expand` | Compaction compresses history; pinned message present after; `/expand` restores snapshot | P9 |
| 20 | Self-verify Tier 1 | muonroi-cli | `self-verify` | `bun run src/index.ts self-verify --since HEAD~1 --max 4` | Reads diff, drives scenarios, judges pass/fail; emits `tests/harness/auto/*.spec.ts`; ~30s, no LLM cost | P8 |

## Tier 3 — Advanced (21–30): multi-sprint / BB gate / cross-repo / under load

| # | Subject | Repo | Feature | Run | PASS signal | Pillars |
|---|---------|------|---------|-----|-------------|---------|
| 21 | Multi-sprint council build | muonroi-cli | `/ideal` multi-sprint | `/ideal --force-council --sprint 3 build a Node service exposing /validate + /heartbeat license endpoints (in-memory store, vitest)` | FSM→approved; per-sprint sprint-stage events planning→implementation→verification→judgment; 5-condition done-gate; non-pass → iterates | P3, P1, P11 |
| 22 | BB scaffold through quality gate | muonroi-building-block | `/ideal` + bb-quality-gate | `/ideal build a muonroi-building-block microservice with a fraud-detection rule engine, multi-tenancy, and auth` | Resolves to BB; injects `// >>> muonroi-cli:injected:bb-ecosystem` sentinel; runQualityGate = dotnet restore+build+modular-boundaries → passed:true | P4, P3, P11 |
| 23 | BB CB-1 context injection | muonroi-building-block | `/ideal --debug` | `/debug on` → `/ideal --force-council add a CEP rule engine module to this building-block solution` | conversationContext starts with `## BB context` + `<!-- bb-context-injected:<sha> -->` BEFORE debate; debug shows `bb-dedup=<n>` | P4, P5, P7 |
| 24 | Resume from gate failures | muonroi-building-block | `/ideal --resume` | `bun run src/index.ts /ideal --resume D:\sources\Core\muonroi-building-block` | invalid path→`invalid_path`; no file→`no_gate_failures_file`; with file→continueAsCouncil w/ failure block→`resumed` | P4, P3 |
| 25 | Cost-leak forensics under load | muonroi-control-plane | `usage forensics` | heavy turn: "explore the control-plane auth flow — JWT Bearer + StrictTenantValidationMiddleware + McpTenantContextMiddleware + EF migration chain" → `usage forensics <id> --json` | Per-event JSON; peak single-call input ≤80,000 (no anomaly); B3/B4 "elided by … compactor" stubs visible | P9, P7 |
| 26 | Security audit of yolo session | storyflow | yolo + `--sandbox` + audit | `--sandbox --no-net "in storyflow, run dotnet build and summarize the anti-crawler guardrails"` (yolo) → `usage security-audit --since 1h --format json` | yolo-override / permission-override / shuru-wrap events (redacted cmd) in decision-log; audit surfaces them; nothing dangerous unaudited | P10, P7 |
| 27 | Self-verify Tier 2 agentic | muonroi-cli | `self-verify --agentic` | `self-verify --agentic --goal "open slash menu, go to /cost, run it, confirm cost card renders" --llm "deepseek-v4-flash" --turns 8` | Outer LLM reads semantic tree+events, issues type/press/wait_for/done, reaches goal within budget, reports pass w/ evidence | P8, P7 |
| 28 | EE graceful-degrade under outage | experience-engine | `/ee` + circuit breaker | stop EE server → `/ee stats`; MCP `ee_health`; `ee_query "..."` | `ee_query`/`ee_health` → `{error:'ee_unavailable'}`, run continues; pilContext circuit opens after 5 fails/30s, returns null, logs (no crash) | P5, P7 |
| 29 | Cross-repo council w/ research | muonroi-license-server | `/discuss`+`/plan`+`/council` | `/discuss design /validate returning isValid+allowedFeatures, cross-check vs control-plane gating` → `/plan` → `/council 3 should feature-gating live in license-server or control-plane?` | `/discuss` captures gray areas; `/plan` gated on unresolved → roadmap.md only when unblocked; `/council` 3 rounds cite real files in both repos | P1, P7, P2 |
| 30 | Export divergence-labelled transcript | quick-codex | `/export` + `/clear` | multi-turn about qc-flow vs qc-lock continuity → `/export` → `/clear` → verify relock | `/export` merges DB ModelMessages + scrollback, labels divergence; `/clear` relocks from `.muonroi-flow`, emits `__CLEAR__` re-injecting relock summary | P9, P7 |

---

## Coverage map

- **Surface:** every slash command exercised — `/route /cost /status /ideal /optimize /council /pin /compact /expand /ee /debug /discuss /plan /export /clear` — plus subcommands `models doctor usage(report|forensics|security-audit) self-verify(Tier1/Tier2) mcp-driver` and headless `-p` / `--smoke-boot-only`.
- **Pillars:** all 11 covered; P7 (evidence-first) and P9 (cost-flat) appear most (they are cross-cutting).
- **Repos:** muonroi-cli, building-block, ui-engine, control-plane, license-server, experience-engine, storyflow, quick-codex. (academy / storyflow_ui / docs are read-targets — swap into tasks 5/12/29 if you want them covered too.)

## Suggested execution order

1. **Smoke gate first** — run 1–4, 7, 8, 18, 20 (deterministic, cheap, no live brain). Any FAIL here = foundational; stop and fix before spending tokens.
2. **Feature completeness** — 5, 6, 9–17, 19.
3. **Mindset-under-load** — 21–30 last; these cost real LLM + dotnet time. Run with a cheap model where the task allows.

## Setup notes per task

- **26, 28** need environment setup: 28 = stop the EE server first; 26 = enable yolo + `--sandbox`.
- **5, 22, 23, 24, 25** need `dotnet` on PATH (verify via task 4 first).
- **17, 27** drive the harness — second terminal recommended.
- **22, 24** mutate `muonroi-building-block` — run on a scratch branch / worktree.
