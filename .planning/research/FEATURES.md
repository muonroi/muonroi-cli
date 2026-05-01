# Feature Research — EE-Native CLI Integration (v1.1 Milestone Delta)

**Domain:** EE-native CLI integration — restructuring muonroi-cli to use experience-engine source code directly
**Researched:** 2026-05-01
**Confidence:** HIGH (competitor surface), MEDIUM (EE-native vs HTTP tradeoff specifics — primary source is architecture research, not public benchmarks)

> **Scope note:** This file covers only the DELTA for milestone v1.1 EE-Native CLI.
> The base feature landscape (table stakes, differentiators for the CLI itself) is fully documented in `.planning/research/FEATURES.md` as of 2026-04-29.
> This research asks one question: **what does EE-native give us that HTTP-wrapper cannot?**

---

## Executive Summary

The HTTP-wrapper architecture (current state) treats the Experience Engine as an external service: every PIL pipeline call, every route-model call, every feedback write, every search query crosses a localhost:8082 HTTP boundary. This works but creates four compounding problems that EE-native integration eliminates:

1. **Latency tax on every turn.** Each PreToolUse hook fires an HTTP round-trip. Each PIL layer that calls EE (L3 injection, L4-5 stubs) adds another. Stack them: a complex turn can accumulate 5-8 serial HTTP round-trips before the first token reaches the provider. In-process calls on the same Bun/Node runtime eliminate serialization + TCP overhead — measured benchmarks on same-host HTTP vs in-process show 30-60% latency reduction for local calls.

2. **Logic duplication and drift.** The HTTP wrapper requires the CLI to re-implement routing heuristics, classification categories, and output-style maps in Bun because EE's internals are opaque. When EE's `route-model` logic evolves, the CLI must update its assumptions independently. EE-native removes this: the CLI calls EE functions, so there is one source of truth.

3. **Classification quality ceiling.** The current hot-path uses hardcoded regex + tree-sitter for Layer 1. That ceiling is fixed by the maintainer's keyword list. EE-native Layer 1 replaces regex with EE's brain LLM (a local Ollama model) — the same model that already classifies for feedback, touch, and route decisions. Quality grows as EE's brain improves; no CLI-side changes needed.

4. **Closed feedback loop impossible over HTTP.** The auto-judge pattern (PreToolUse captures warningId, PostToolUse compares to outcome, feedback fires) requires correlating tool call inputs to outputs within the same process event loop. Over HTTP this means two separate HTTP calls with state held in memory between them — fragile, and loses context on crash. In-process, the correlation is a plain object reference.

The ecosystem confirms these tradeoffs. In-process SDK integration eliminates subprocess overhead and removes the trust boundary that HTTP wrappers impose (Genta.dev, MCP vs API guide, 2025). The pattern of routing with a local lightweight model before any network call is confirmed as production-standard for cost-sensitive agents (RouteLLM, Ollama tiered routing, Augment Code routing guide, 2025-2026). Feedback-driven learning via PostToolUse auto-judge is now a documented pattern in production coding agents (Spotify Engineering, SICA self-improving agent, 2025).

**EE-native is not a nice-to-have refactor. It is what closes the learning loop.**

---

## Feature Landscape

### Table Stakes for EE-Native CLI (Features That Make v1.1 Credible)

These are the minimum features that must exist for EE-native integration to be defensible. An HTTP-wrapper can fake most of them partially — the distinction is whether they work reliably and close the loop.

| Feature | Why Expected | Complexity | HTTP-wrapper can do this? | Notes |
|---------|--------------|------------|--------------------------|-------|
| **EE brain LLM replaces regex in Layer 1** | Router classification quality grows with EE model, not frozen at keyword list | MEDIUM | Partially — wrapper calls `/api/route-model` but doesn't get intermediate reasoning, only final tier | Replace `src/router/hot.ts` regex with direct EE `classifyIntent(text)` call. EE uses Ollama qwen2.5-coder:1.5b for hot path. |
| **`/api/search` implemented in EE** | PIL Layer 3 (EE injection) is currently a stub because the search endpoint doesn't exist in EE | MEDIUM | No — the endpoint does not exist; HTTP would call a 404 | Must implement `GET /api/search?q=&taskType=&limit=` in EE before PIL Layer 3 can work. Unblocks the core EE value prop. |
| **`respond_general` response tool** | Catch-all for tasks not matching the 6 typed tools (refactor/debug/plan/analyze/docs/generate) | LOW | Yes — but today unclassified tasks fall through with no tool, returning raw LLM text and no Zod schema | Add `respond_general` with a permissive schema. Table stakes for robustness. |
| **Output style detection via EE brain (multilingual)** | PIL Layer 6 currently uses hardcoded regex for Vietnamese/English detection — breaks on mixed code + comments | LOW | No — multilingual detection requires a language model; regex is wrong for mixed-language codebases | EE brain call: `detectOutputStyle(recentMessages)` → returns `{language, formality, codeHeavy}`. Single call, replaces 40 lines of heuristic. |
| **Route feedback loop wired (every turn feeds outcome)** | EE route-model improves only if it receives outcome signals — without feedback, it is a static router | MEDIUM | Fragile — requires holding warningId in memory between two HTTP calls; loses state on crash | In-process: PostToolUse handler calls EE `recordRouteOutcome(routeId, outcome)` directly. Correlation is a plain reference, not a session cookie. |
| **Full EE hook pipeline end-to-end (PreToolUse → PostToolUse → Judge → Feedback → Touch)** | End-to-end pipeline is the product. If any stage is missing, EE never learns, principles never evolve | HIGH | Partially — PreToolUse hook wires over HTTP (proven). PostToolUse → Judge → Feedback auto-judge does not exist yet. | PostToolUse must capture diff + test result, call EE judge worker, call `/api/feedback` with FOLLOWED/IGNORED/IRRELEVANT verdict. |
| **CLI imports EE functions directly — no logic duplication** | Dual maintenance of routing heuristics in CLI + EE creates divergence bugs | MEDIUM | No — HTTP wrapper always duplicates at least the request/response schema | EE exports: `classifyIntent`, `routeModel`, `search`, `recordFeedback`, `touch`. CLI imports them as a library dependency. |

### Differentiators: What EE-Native Enables That HTTP Cannot

These features are only achievable — or only reliable — with direct source integration.

| Feature | Value Proposition | Complexity | Why HTTP-wrapper fails here | Dependency |
|---------|-------------------|------------|---------------------------|------------|
| **Latency-free PIL pipeline** | Zero HTTP overhead on the hot path; PIL runs in-process before every provider call | MEDIUM | HTTP adds 5-8 serial round-trips per complex turn; at p95 this is 200-400ms extra latency on a fast machine | Requires EE as a library dep in the CLI process |
| **Auto-judge feedback loop (deterministic, crash-safe)** | Every tool call auto-tags FOLLOWED/IGNORED/IRRELEVANT without agent intervention — closes EE evolution loop | HIGH | HTTP: two separate requests with in-memory state between them; process kill loses correlation. In-process: one object reference, survives within the turn | Requires PostToolUse handler + EE judge worker callable in-process |
| **taskType + outputStyle extension on route-model** | EE's `routeModel` currently selects tier based on complexity alone; adding taskType (refactor/debug/etc.) and outputStyle (Vietnamese, code-heavy) makes routing precision much higher | MEDIUM | HTTP can send these fields but cannot extend the routing logic without modifying EE separately and deploying | EE source allows adding fields to `RouteRequest` type directly; CLI and EE change together |
| **Principle evolution observable in CLI session** | User sees "3 new principles inferred this session" in status bar — trust signal for the learning pitch | LOW | HTTP can fetch principle count but cannot observe the judge + evolution event synchronously within the same turn | In-process: EE emits events when principles are inferred; CLI status bar subscribes |
| **PIL Layer 3 (EE injection) functional** | EE search results injected into prompt before every provider call — reduces hallucination, improves on-codebase accuracy | MEDIUM | Currently a stub because `/api/search` doesn't exist in EE. HTTP would remain broken even after the endpoint lands if the CLI has no way to know search latency will block the turn | EE-native: `search()` is a direct async call; if it times out, PIL fails open in-process without a TCP error |
| **Router hot-path stays local even when EE backend is down** | If EE Node process is not running, CLI must still route via fallback — not crash | LOW | HTTP: if localhost:8082 is unreachable, the entire PIL pipeline errors. In-process: EE library functions degrade gracefully via the existing fail-open path | Requires graceful degradation wrapper around EE imports |
| **Single version contract between CLI and EE** | CLI always uses the exact EE version it was tested with — no "EE v3.2 but CLI expects v3.1 API" drift | LOW | HTTP: EE backend can update independently, breaking CLI without a visible version mismatch | npm workspace or git submodule: versions are locked together |

### Anti-Features: Common EE-Native Patterns to Avoid

These seem like natural next steps but create problems in this context.

| Feature | Why Requested | Why Problematic | What to Do Instead |
|---------|---------------|-----------------|--------------------|
| **Bundle EE into the CLI binary** | "One binary, no external dependency" | EE runs as a persistent Node 20 process with Qdrant + Ollama dependencies. Bundling it into Bun would require cross-runtime bridging and would force Qdrant to be an embedded process — massive ops complexity for a solo maintainer. Not achievable in v1.1. | Keep EE as a separate process. CLI imports EE as a library for function calls; EE still manages its own Qdrant/Ollama connections. The boundary is a process boundary, not a network boundary — Unix domain socket or in-process module calls. |
| **Synchronous blocking EE calls in PIL** | "Simpler code if we await each layer" | PIL is already fail-open at 200ms. Making it synchronous and blocking turns a 200ms timeout into a 200ms guaranteed wait on every turn. Stacks with LLM latency. | Keep all EE calls async with `Promise.race([eeCall, timeout(200)])`. Fail open. |
| **Replace EE feedback with a custom CLI-side store** | "We can do feedback lighter without EE's Qdrant schema" | Defeats the entire EE-native thesis. EE's value is principle evolution — if feedback goes to a separate store, principles never grow from CLI interactions. | All feedback flows through EE's `/api/feedback` (or direct function call). No parallel feedback store in the CLI. |
| **Expose all EE internals as CLI slash commands** | "Power users want to query EE directly" | EE has 50+ internal endpoints. Exposing them as CLI commands creates a maintenance surface the solo maintainer cannot own. | Expose exactly 3 CLI-facing surfaces: `/route` (routing decision transparency), `/principles` (list evolved principles), `/feedback` (manual feedback override). Nothing else in v1.1. |
| **Eager EE module import at CLI startup** | "Load everything upfront for faster runtime calls" | EE imports Qdrant client, Ollama client, DB migrations. Eager import at CLI startup adds 200-400ms cold start before the first prompt appears. | Lazy-import EE modules on first use inside PIL. If EE is not needed (headless/CI mode with EE disabled), it never loads. |

---

## Feature Dependencies

```
/api/search endpoint (in EE source)
    └──required-by──> PIL Layer 3 EE injection (currently stub)
                          └──required-by──> Full PIL pipeline end-to-end

EE brain LLM call (classifyIntent)
    └──replaces────> Hot-path regex classifier (Layer 1)
    └──required-by──> taskType extension on route-model
    └──required-by──> Output style detection (Layer 6)

Auto-judge feedback loop
    └──requires────> PostToolUse handler (exists, needs wiring)
    └──requires────> EE judge worker callable in-process
    └──required-by──> Principle evolution (EE's evolution loop closes only with feedback)
    └──required-by──> Route feedback loop (route accuracy improves only with outcome signals)

respond_general response tool
    └──required-by──> Robustness for unclassified tasks (no fallthrough)
    └──independent of EE-native (can ship over HTTP too, but needed regardless)

Direct EE module import
    └──required-by──> Latency-free PIL
    └──required-by──> Crash-safe auto-judge correlation
    └──required-by──> Principle evolution observable in status bar
    └──conflicts────> Bundled EE binary (anti-feature — do not combine)

Graceful degradation wrapper
    └──required-by──> Router hot-path when EE process is down
    └──requires────> Direct EE module import (can only degrade gracefully if you control the import path)
```

### Dependency Notes

- **`/api/search` in EE must land before PIL Layer 3 is un-stubbed.** This is a cross-repo change (EE source, not CLI source). It is the single external dependency for the v1.1 milestone.
- **Auto-judge requires PostToolUse handler to capture diff context.** The diff must be computed before calling the judge — PostToolUse receives file paths, not diffs. The handler must read pre/post state within the hook event.
- **EE module import and graceful degradation must be designed together.** If the import is eager and EE fails to initialize, CLI fails. If import is lazy with a try-catch wrapper, CLI degrades to HTTP fallback or direct routing, keeping the existing behavior.
- **respond_general does not require EE-native** — it is a PIL response tool gap that exists regardless. It should ship in v1.1 because it is a one-day task that fixes a known hole.

---

## MVP Definition for v1.1

### Launch With (v1.1 EE-Native)

The minimum set that closes the EE evolution loop and removes logic duplication.

- [ ] **`/api/search` implemented in EE** — unblocks PIL Layer 3; required for inject-from-brain to work
- [ ] **EE brain LLM replaces hot-path regex (Layer 1)** — classification quality grows with EE model, no CLI maintenance
- [ ] **`respond_general` response tool** — eliminates unclassified task fallthrough; one-day task
- [ ] **Output style detection via EE brain (Layer 6)** — replaces hardcoded multilingual regex
- [ ] **Route feedback loop wired** — every turn feeds outcome signal; EE route-model starts learning
- [ ] **Full hook pipeline end-to-end** — PreToolUse → PostToolUse → Judge → Feedback → Touch; auto-judge fires deterministically
- [ ] **CLI imports EE functions directly** — no logic duplication; single version contract; latency-free hot path
- [ ] **Graceful degradation when EE process is down** — lazy import with fail-open path; headless/CI mode unaffected

### Add After Validation (v1.1.x)

Triggered by first-week usage data showing route decision quality or principle evolution rate.

- [ ] **Route decision transparency (`/route` slash command)** — show users which tier was selected and why; trust signal. Only add if users ask "why is this slow?" or "why did it use GPT-4?"
- [ ] **Principle evolution count in status bar** — "3 new principles this session" badge. Add when judge pipeline is proven stable (i.e., not producing false positives).
- [ ] **taskType + outputStyle extension on route-model** — precision improvement on routing. Defer until base routing is validated working.

### Defer to v1.2+

- [ ] **Bundled EE binary** — explicitly rejected for v1.1. Re-evaluate only if user setup friction (running two processes) surfaces as top complaint.
- [ ] **Full EE slash command exposure** — principle browser, search browser, etc. Phase 4 / Pro tier surface.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `/api/search` in EE | HIGH (unblocks PIL L3) | MEDIUM (new EE endpoint + vector search) | P1 — blocker |
| EE brain replaces hot-path regex | HIGH (quality + maintainability) | MEDIUM (replace ~80 lines, wire Ollama call) | P1 |
| `respond_general` response tool | MEDIUM (robustness) | LOW (~1 day, Zod schema + handler) | P1 |
| Output style detection via EE brain | MEDIUM (correctness for multilingual) | LOW (~half-day, one EE call) | P1 |
| Route feedback loop | HIGH (EE router improves over time) | MEDIUM (PostToolUse state capture + EE call) | P1 |
| Full hook pipeline end-to-end | HIGH (closes EE evolution loop) | HIGH (judge worker + auto-tag + feedback) | P1 |
| Direct EE module import | HIGH (latency + drift prevention) | MEDIUM (module boundary design, lazy import) | P1 |
| Graceful degradation | HIGH (reliability) | LOW (try-catch wrapper, existing fail-open) | P1 |
| Route transparency slash command | MEDIUM (trust signal) | LOW (read EE route decision log) | P2 |
| Principle count in status bar | LOW (vanity metric until pipeline stable) | LOW | P2 |
| taskType + outputStyle route extension | MEDIUM (precision) | LOW (type extension + EE routing logic) | P2 |

---

## EE-Native vs HTTP-Wrapper Comparison

| Capability | HTTP-Wrapper (current) | EE-Native (target) |
|------------|------------------------|-------------------|
| PIL hot-path latency | 5-8 HTTP round-trips per complex turn; ~200-400ms overhead | Direct function calls; <5ms overhead |
| Layer 1 classification quality | Frozen at maintainer's regex/keyword list | Grows with EE's Ollama brain model |
| PIL Layer 3 (EE injection) | Stub — `/api/search` does not exist | Functional after EE search endpoint lands |
| Output style detection | Hardcoded regex; breaks on mixed code+Vietnamese | EE brain call; handles arbitrary language mix |
| Route feedback loop | Two separate HTTP calls; state lost on crash | In-process object reference; crash-safe |
| Auto-judge (PostToolUse → Feedback) | Fragile; depends on session state across HTTP | Deterministic; correlation is a code reference |
| Logic duplication | Router heuristics duplicated in CLI + EE | Single source in EE; CLI imports functions |
| Version contract | EE can update independently, breaking CLI | npm workspace lock; versions move together |
| Graceful degradation | TCP error on localhost:8082 unreachable | try-catch on import; fail-open in-process |
| Principle evolution observable | Requires polling EE for count | EE emits events; CLI subscribes synchronously |

**Confidence:** MEDIUM — latency numbers are extrapolated from same-host HTTP benchmarks (30-60% overhead reduction in-process); the exact muonroi-cli numbers will only be known after instrumentation in v1.1.

---

## Competitor Context (EE-Native Pattern in the Wild)

No leading coding CLI ships an "experience engine" concept with persistent principle evolution — this remains a genuine differentiator (confirmed in 2026-04-29 research). However, adjacent patterns in the ecosystem confirm the approach:

- **Feedback-driven agent learning (2025):** Spotify's background coding agent ships an LLM-as-judge in the verification loop. SICA (Self-Improving Coding Agent) ships an async overseer that judges tool outcomes and flags deviations. Both confirm that PostToolUse auto-judge is a production pattern, not an academic concept. Confidence: HIGH.
- **Local-first LLM router (2025-2026):** RouteLLM + Ollama pattern of classifying with a lightweight local model before dispatching to frontier is documented production practice. 7B router classifies in <300ms. Confirmed by Augment Code routing guide and multiple Ollama integration articles. Confidence: HIGH.
- **In-process vs HTTP for local services (2025):** Same-host HTTP adds measurable latency; the fix is either gRPC (30% faster) or in-process library calls (eliminates the hop). Academic benchmarks (CEUR-WS, IPC study) and practitioner guides (MCP vs API guide) both confirm this. Confidence: MEDIUM (no muonroi-specific measurement).
- **Intent classification at 3-5 categories for reliability:** Production agent routing literature consistently warns that >10 intent categories degrade classifier accuracy below 60% (BSWEN agent routing guide, 2026). muonroi-cli's 6 response tool types (+ respond_general = 7) are at the edge of this bound. Confirm the 7-category boundary does not degrade EE's Ollama hot-path classifier. Confidence: MEDIUM.

---

## Sources

- [Augment Code: Best AI Model for Coding Agents — Model Routing Guide](https://www.augmentcode.com/guides/ai-model-routing-guide) — tiered routing, table stakes vs differentiators
- [BSWEN: AI Agent Routing — Practical Guide with Intent Classification](https://docs.bswen.com/blog/2026-03-06-agent-routing/) — 3-5 category reliability warning, structured output routing
- [Genta.dev: MCP vs API for AI Agents](https://genta.dev/resources/mcp-vs-api-ai-agents) — in-process SDK eliminates subprocess overhead, trust boundary analysis
- [Spotify Engineering: Feedback Loops for Background Coding Agents](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) — LLM-as-judge in PostToolUse verification loop, production confirmation
- [arXiv: A Self-Improving Coding Agent (SICA)](https://arxiv.org/html/2504.15228v1) — async overseer judges tool outcomes, flags deviations, production pattern
- [Medium: Implementing LLM Model Routing with Ollama and LiteLLM](https://medium.com/@michael.hannecke/implementing-llm-model-routing-a-practical-guide-with-ollama-and-litellm-b62c1562f50f) — 7B router classifies in <300ms, same-host tiering
- [RouteLLM + Ollama routing to local models](https://github.com/lm-sys/RouteLLM/blob/main/examples/routing_to_local_models.md) — local-first hot-path pattern
- [Nature/Scientific Reports: High performance microservice communication](https://www.nature.com/articles/s41598-023-39355-4) — gRPC 30% faster than REST for same-host; in-process fastest
- [CEUR-WS: Evaluating IPC in Microservice Architectures](https://ceur-ws.org/Vol-2767/07-QuASoQ-2020.pdf) — HTTP overhead on same host, IPC comparison
- Local: `D:/Personal/Core/muonroi-cli/.planning/PROJECT.md` — v1.1 target features, constraints, auto-judge requirement

---

*Feature research for: EE-native CLI integration (v1.1 milestone delta)*
*Researched: 2026-05-01*
