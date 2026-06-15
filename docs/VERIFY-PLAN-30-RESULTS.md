# Verification Run — Results (Pass 1)

> Live execution of [VERIFY-PLAN-30.md](VERIFY-PLAN-30.md). **C** = Completeness, **M** = Mindset. PASS / PARTIAL / FAIL.
> Branch `feat/council-derobotize` @ `9daf738` (+ AbortSignal WIP unstaged). Date 2026-06-15.
> **Method legend:** `live` = ran the real CLI/TUI · `spec` = deterministic test spec (logic oracle, mocked LLM) · `code` = source-path review · `deferred` = not run this pass (cost/env), rationale given.

## Environment gating facts

| Fact | Value | Impact |
|------|-------|--------|
| bun | 1.3.13 | OK |
| dotnet | 10.0.201 present | BB tasks runnable |
| API keys | deepseek, siliconflow, openai (no **xai**) | keyed models work; TUI default (xai) blocked → F7 |
| EE brain | **UP** (ee_health 200, ee_query 18 entries) — but `doctor` says DOWN → **F9** | recall works; true-outage test (28) not possible |
| local NuGet | `Muonroi.BaseTemplate@1.0.0-alpha.3` missing → **F11** | BB template install fails |

## Findings log (severity-ranked)

| ID | Sev | Task | Finding |
|----|-----|------|---------|
| **F10** | **HIGH** | 5 | **Headless `-p` never exits after a tool-using turn.** ROOT-CAUSED via `--format json` diag: the turn **completes correctly** (read_file 34ms → final answer `"version is 1.4.1. Evidence: [package.json:6]"`, finishReason=stop, ~15s) but the **process then idles ~255s until killed**. A lingering open handle keeps the event loop alive; no forced exit after `agent.cleanup()`. No-tool/chitchat (PONG) exits fine — the tool path opens a resource that isn't torn down. CI/scripting path → still HIGH, but cheap fix (close handles + exit). |
| **F12** | Med | 5 | `[MCP] buildMcpToolSet timed out or failed, proceeding with builtins only` in headless — MCP tool-set build times out (servers unreachable headlessly). Likely the lingering-handle source behind F10 (pending MCP connection/timer). |
| **F5** | Med | 8 | **Slash menu: exact command-name match is not prioritized over description-substring match.** Typing the exact `/status` selects `/ee` first (word "status" is in `/ee`'s description) → Enter runs the wrong command. |
| **F6** | Med | 6 | `/route` is `hidden:true` (menu-items.ts:71). Typing it shows the default menu with **`/exit` pre-selected** → Enter risks quitting. Hidden + footgun (ties to F5). |
| **F9** | Med | 28 | **`doctor` false-negative on EE.** Reports "EE unreachable — check VPS …" while live `ee_health`=200 and `ee_query` returns 18 entries. Doctor even self-contradicts: WARN text says unreachable but its own field says `server=ok`. |
| **F1** | Med | 4 | `doctor` does **not** probe `dotnet` despite BB-aware .NET scaffolding being a core pillar — BB/.NET tasks have no preflight (dotnet IS installed; doctor is blind to it). |
| **F11** | Med | 22 | `Muonroi.BaseTemplate@1.0.0-alpha.3` not in local NuGet feed → `dotnet new install` fails. Spec skipped gracefully + logged (no silent catch ✓), but real BB scaffold can hit it. |
| **F8** | Low-Med | 20 | `self-verify --since HEAD~1` on a `src/ui/**`-touching commit planned **only the generic smoke-boot scenario** — touched-Semantic-ID→scenario mapping found nothing for `message-view.tsx`/`text.ts`. |
| F2 | Low | 3 | `catalog.json` `grok-4.3` + `grok-build-0.1` descriptions are Vietnamese (English-data convention); each lists its own id as an alias (redundant). |
| F3 | Low | 2 | `--format text` emits `⏳ Processing…` (ANSI) + `Session: <id>` to stdout — non-reply noise for pipe consumers. Reply itself clean. |
| F4 | Low | 18 | `usage report` `orchestrator.message` callsite shows `durationMs:0`/`driftSamples:0` — duration/drift not recorded for the main callsite. |
| F7 | Info? | — | TUI default model `grok-build-0.1` is provider **xai** but no xai key present → only chitchat short-circuit works in default TUI. May be env-specific config; needs confirm. |

## Task results

### Tier 1 — Basic

| # | Subject | Method | C | M | Evidence |
|---|---------|--------|---|---|----------|
| 1 | Boot smoke | live | PASS | PASS | exit 0, "config + usage loaded", no keychain prompt |
| 2 | Headless ping | live | PASS | PASS | stdout `PONG` plain; no respond_* leak (F3 minor) |
| 3 | Model catalog | live | PASS | PASS | 20 models catalog-derived w/ provider+tier+pricing (F2 minor) |
| 4 | Doctor | live | PASS | PARTIAL | 6 pass/3 warn/0 fail, concrete per-dep; M=PARTIAL: omits dotnet (F1), EE false-neg (F9) |
| 5 | Explain rule-engine | live | PARTIAL | PASS | Output is correct + evidence-first (`"…1.4.1. Evidence: [package.json:6]"`, no respond_* wrapper) → M=PASS. C=PARTIAL: process never exits (F10) |
| 6 | Route decision | live | PASS | PASS | msg-3 Tier=hot/Provider/Model card. Caveat F6 (hidden) |
| 7 | Cost card | live | PASS | PASS | Provider/Model/Tier card renders with no active run |
| 8 | Status (no run) | live | PASS | PASS | Progress card, empty backlog, no crash. (Bug F5 hit en route) |
| 9 | Hot-path ideal | spec | PASS | PASS | complexity/hot-path/sufficiency + route-decision-emit specs green (144/144) |
| 10 | PIL layer table | live | PASS | PASS | msg-4 "Enriched prompt:" PIL output (full table body truncated by harness) |

### Tier 2 — Intermediate

| # | Subject | Method | C | M | Evidence |
|---|---------|--------|---|---|----------|
| 11 | Council design-fork | spec | PASS | PASS | council specs 156/156 green (17 files) |
| 12 | Askcard grounded | spec | PASS | PASS | discovery.test.ts green (proposer recs + defaultIndex) |
| 13 | No-clarify gate | spec | PASS | PASS | clarity-gate.test.ts green (NO_CLARIFY_RE suppression) |
| 14 | Scaffold small project | spec | PASS | PASS | route-decision/sufficiency + scaffold init-new/point-to-existing specs green |
| 15 | Optimize impl-turn | spec+live | PASS | PASS | layer4-gsd + layer6-output specs green; /optimize ran live (10) |
| 16 | EE recall+feedback | live | PASS | PASS | ee_query → 18 ranked `[id col]` entries (feedback-gate not exercised) |
| 17 | MCP drive TUI | live | PASS | PASS | tui.* advertised; named-pipe spawn OK; bad argv → `argv_rejected` |
| 18 | Usage by callsite | live | PASS | PASS | valid JSON; aggregate cache ratio ~88% = cost-flat evidence (F4 minor) |
| 19 | Pin survives compaction | deferred | — | — | not run: LLM compaction cost + harness truncation. Logic in /pin+/compact sentinels |
| 20 | Self-verify T1 | live | PASS | PASS | 1/1 passed, emitted regression spec. Coverage thin (F8) |

### Tier 3 — Advanced

| # | Subject | Method | C | M | Evidence |
|---|---------|--------|---|---|----------|
| 21 | Multi-sprint build | spec | PARTIAL | PARTIAL | sprint-stage/route-decision + integration specs green; full multi-sprint LLM E2E deferred (cost) |
| 22 | BB scaffold + gate | code | PASS | PASS | bb-quality-gate.ts: 5 steps + retry-council + EE-GATE-FAILURES fallback, sound. Full E2E deferred (cost + F11) |
| 23 | BB CB-1 injection | deferred | — | — | needs a real council /ideal run (cost); EE up but injection path not live-run |
| 24 | Resume gate-failure | spec | PASS | PASS | continue-as-council + continuation-prompt specs green (resume mechanism) |
| 25 | Forensics under load | live | PASS | PASS | structured JSON, peak 17,090 ≤80K; true heavy-load run deferred |
| 26 | Audit yolo session | live | PASS | PASS | 419 decisions/89 overrides; yolo-override + redacted cmds + spend tables |
| 27 | Self-verify T2 | deferred | — | — | LLM cost; Tier1 (20) already proved harness loop |
| 28 | EE outage degrade | code | — | — | EE actually UP → true-outage not testable; F9 found instead. Degrade path = bridge circuit breaker (code) |
| 29 | Cross-repo council | deferred | — | — | expensive 3-round council+research; council logic spec-verified (11) |
| 30 | Export + relock | deferred | — | — | /export+/clear UI; needs session + harness truncation limits verification |

## Pass-1 scoreboard

- **Verified PASS:** 21 tasks (14 live + 6 spec + 1 code) — 1,2,3,4,6,7,8,9,10,11,12,13,14,15,16,17,18,20,22,24,26
- **PARTIAL:** 2 — 21 (sprint E2E), 25 (load)
- **FAIL:** 1 — **5 (F10 headless hang)**
- **Deferred (cost/env):** 6 — 19,23,27,28,29,30 (the most expensive real-LLM/E2E; deferring honors "cheapest cost")
- **Findings:** 11 (1 HIGH, 5 Med, 1 Low-Med, 3 Low, 1 Info)
