# Pitfalls Research

**Domain:** BYOK AI coding agent CLI built by forking and amputating `grok-cli`, integrated with Experience Engine (Qdrant + EE server) and Quick Codex run-artifact system, distributed cross-platform with eventual SaaS billing layer.
**Researched:** 2026-04-29 (base) / 2026-05-01 (milestone v1.1 EE-Native CLI addendum)
**Confidence:** HIGH for fork/BYOK/router/EE/QC dimensions (direct domain knowledge + verified sources). MEDIUM for Phase-4 SaaS pitfalls (forward-looking, less direct evidence). MEDIUM for cross-platform pitfalls (verified through GitHub issue threads on Bun/Ollama).

This document catalogs failure modes specific to muonroi-cli's design — fork-and-amputate baseline, BYOK pricing, 3-tier brain router, Usage Guard, EE/QC integration, multi-platform shipping, and Phase-4 SaaS prep. Each entry is severity-ranked and phase-mapped so the roadmapper can prioritize prevention.

The **v1.1 EE-Native CLI Milestone Addendum** (Pitfalls 31–42) is appended below the original pitfalls. It covers integration-specific failure modes that arise when importing `experience-core.js` (pure CJS, zero npm deps, Node 20+) directly into a Bun ESM codebase rather than via HTTP.

---

## Critical Pitfalls (HIGH severity)

### Pitfall 1: Untracked upstream creates security debt and AI SDK drift

**What goes wrong:**
The IDEA explicitly says "fork once clean, accept maintenance ownership — no upstream tracking." Six months later AI SDK v6 emits a CVE patch in a v6.4.x release. We have no automated mechanism to discover it. Meanwhile our adapter still depends on internal AI SDK stream-protocol shapes that change in v6.4 — `convertToModelMessages` is now async, `ToolCallOptions` was renamed to `ToolExecutionOptions`. Our static fork has the old shapes. We either ignore the CVE or we eat a multi-day migration.

**Why it happens:**
"No upstream tracking" gets misread as "ignore upstream entirely." The fork-and-amputate decision was correct for greenfield velocity, but it does not exempt us from watching `oven-sh/bun`, `vercel/ai`, `opentui`, MCP SDK, and the LSP client we kept. Once amputated, the `grok-cli` codebase is OURS, but its dependencies still publish independently.

**How to avoid:**
- Maintain a `UPSTREAM_DEPS.md` in the fork root listing every kept-upstream package with the version pinned at fork time
- Subscribe to GitHub release feeds for: `oven-sh/bun`, `vercel/ai`, MCP TypeScript SDK, OpenTUI, the LSP client repo
- Run `bun outdated` weekly in CI; flag major version bumps as an issue, not a silent dependabot PR
- Pin AI SDK to a known-good minor (e.g. `^6.0.x`) and explicitly review each minor before bumping — codemods exist (`npx @ai-sdk/codemod v6`) but only cover known migrations, not custom integration points

**Warning signs:**
- A `bun install` after a refresh succeeds but tool-call streaming silently truncates (signature changed, types compile, runtime breaks)
- A user reports that the same prompt works on Claude Code but loops on muonroi-cli (we're on a stale provider SDK)
- Dependabot PR queue grows past 10 — the team is no longer reading them

**Phase to address:**
**Phase 0** — `UPSTREAM_DEPS.md` is part of the fork commit. CI dependency check is part of the Phase 0 build pipeline.

---

### Pitfall 2: API key leaks via shell history, logs, env dumps, or telemetry

**What goes wrong:**
A user runs `ANTHROPIC_API_KEY=sk-ant-... muonroi-cli ...` because our README example shows it. The key is now in `.bash_history` / PowerShell `ConsoleHost_history.txt` forever. Or an unhandled exception's stack trace is logged with the full request headers. Or a verbose mode prints the request payload including `Authorization: Bearer ...`. The user blames us, posts on Twitter, and the product is dead before launch.

**Why it happens:**
- BYOK means the secret lives on the user's machine — every leak vector is now ours to defend against
- Easy debugging logs that print full HTTP requests are tempting in early development
- "Just put it in .env" is the default README example for every CLI ever
- Process environment variables on some operating systems are world-readable by other processes; exported env vars get passed to every child process

**How to avoid:**
- Do NOT document `KEY=... muonroi-cli` invocation in README. Document only:
  - Encrypted config file at `~/.muonroi/credentials` (file mode `0600`, encrypted with OS keychain via `keytar` or equivalent)
  - OS keychain integration (Windows Credential Manager, macOS Keychain, libsecret on Linux)
  - One-shot interactive prompt if the keychain is unavailable
- Implement a mandatory log redactor that scrubs anything matching `sk-`, `sk-ant-`, `gsk_`, JWT shapes, and headers named `authorization|x-api-key|api-key` BEFORE log output, including stack traces
- Crash reporter (if one is added later) MUST send through the same redactor and MUST NOT capture environment variables
- Provider error responses sometimes echo the masked key — verify the masking is done by the provider, not assumed
- Audit the inherited `grok-cli` code for ANY `console.log`, `IMLog`-equivalent, or `Sentry.captureException` calls that touch request/response objects

**Warning signs:**
- Grep the codebase for `console.log(.*request)`, `console.log(.*headers)`, `JSON.stringify(.*config)` — every hit is a potential leak
- A bug report arrives with a copied-pasted log line from the user that contains a partial key prefix
- Crash reports (if any) contain process env in the payload

**Phase to address:**
**Phase 0** — log redactor + keychain integration are part of the Usage Guard skeleton, before any provider adapter ships. Cannot be retrofitted because by the time a leak is reported, the key is already in someone else's hands.

---

### Pitfall 3: Usage Guard cap-enforcement race lets parallel tool calls overshoot

**What goes wrong:**
User has $0.50 of budget remaining. The agent dispatches 5 parallel tool calls because the model is doing investigation. Each one starts streaming, each one independently checks "am I under cap?" and sees `yes`. All 5 complete and the user is now $2 over cap. The auto-downgrade chain never engaged because the cap-check is per-call, not global. The user sees their cap was exceeded — exactly the failure mode the Usage Guard exists to prevent — and the product loses trust.

**Why it happens:**
The naive cap-check pattern is "before each call, read counter, if under cap continue, else halt." This is a classic check-then-act race. Streaming responses make it worse — by the time the first chunk lands, decisions to start subsequent calls have already been made. Token counter drift between provider-reported usage and our local count (providers often update counters lazily) compounds the gap.

**How to avoid:**
- Maintain a **reservation ledger**, not a simple counter:
  - Before dispatching a call, RESERVE the worst-case projected cost (max output tokens × output price)
  - When the call completes, RECONCILE: actual cost replaces reservation
  - When the call fails, RELEASE the reservation
- Cap check is `current_spend + reservations + projected_call <= cap`, atomic per-process
- Limit concurrent tool calls: when remaining budget < 2× single-call worst-case, force `max_concurrent = 1`
- When over cap, halt the AGENT LOOP, not just future tool calls — already-streaming responses must be awaited but no NEW model calls issued
- Test scenario: simulate 10 concurrent calls each with worst-case 4K output tokens at $3/1M → assert ledger blocks at cap, not over

**Warning signs:**
- Beta tester reports "you said cap was $15 but I got billed $17" — production-grade trust failure
- Token counts in our display don't match the provider dashboard at end of month (within 5% drift acceptable; >10% means the ledger is broken)
- Concurrent tool calls during agent loops show non-monotonic spend display (counter goes backwards, then forwards)

**Phase to address:**
**Phase 0** — Usage Guard is mandatory in Phase 0 per IDEA. The reservation-ledger design must be in Phase 0 even if the auto-downgrade chain ships in Phase 1. The IDEA's explicit success criterion ("Usage guard never lets the user exceed their cap — verified via runaway-scenario tests") demands this.

---

### Pitfall 4: Per-user Qdrant collection leak — one user sees another's principles

**What goes wrong:**
Phase 4 ships cloud EE. The migration from local-Qdrant to multi-tenant Qdrant uses a single shared collection with `tenant_id` payload filtering (the Qdrant-recommended pattern). A bug in the EE judge worker — a missed filter in a `search` call, a wrong default in the SDK wrapper, or a cross-tenant query during principle deduplication — exposes user A's principles (which often contain code snippets, file paths, project names, internal patterns) to user B. This is a data breach under GDPR and a product-killing trust event.

**Why it happens:**
- Qdrant's documented multi-tenant pattern is single-collection-with-payload-filter — efficient, but every query needs the filter and there's no schema-level guarantee
- Principles are not just metadata — they often quote source code, error messages, file paths from the user's repo
- The judge worker runs cross-tenant aggregations (deduplication, principle clustering) which are easy to write without filters
- Local-to-cloud migration code is written once and rarely audited again

**How to avoid:**
- Use Qdrant's **tiered multi-tenancy** (1.16+) where each tenant gets dedicated shards once they grow, with hard isolation — not just payload filtering
- For free tier on shared shard, EVERY query MUST go through a `getCollection(tenantId)` wrapper that injects the filter — no raw `client.search` calls allowed
- Lint rule or pre-commit check that bans direct Qdrant SDK calls outside the wrapper
- Judge worker that does cross-tenant work uses a SEPARATE service account and writes to a non-tenant-readable collection
- Penetration-test the API: log in as user A, request user B's principles by ID — must return 404, not the principle
- Audit log every cross-tenant query and alert on anomalies

**Warning signs:**
- Code review finds a `qdrant.search()` call without a tenant filter — every one is a P0 bug
- A user reports seeing a principle they didn't author (possibly innocuous-looking, but indicates filter bypass)
- The judge worker's logs show it accessing collections it shouldn't
- A free user upgrades to Pro and their principle count changes by a non-trivial amount (might mean their data was leaking into a shared pool)

**Phase to address:**
**Phase 4** — but the architecture decision must be made in Phase 1 when EE PreToolUse hooks are wired. Specifically: the EE client SDK's interface should have `tenantId` as a required parameter from day 1, even when running local (single-tenant), so Phase 4 doesn't introduce a new code path that has to be retrofitted.

---

### Pitfall 5: Stripe webhook duplicate processing causes double-billing or double-provisioning

**What goes wrong:**
Stripe sends the `customer.subscription.created` event twice (network blip, our handler timed out, retry queue). Our webhook handler is naive — it provisions the user's Pro tier (creates Qdrant collection, marks user as Pro in DB) on every receive. Now the user has two Qdrant collections, two Pro subscriptions counted in our metrics, and possibly two Stripe customer-side records. Or — more commonly — we charge the user twice because we manually invoiced on each event.

**Why it happens:**
Stripe guarantees AT-LEAST-ONCE delivery, never exactly-once. Common causes of duplicates: handler took >20s and Stripe retried; Stripe's queue redelivered after a transient failure; signature verification passed but the event was actually a retry. AI-generated payment code commonly skips idempotency because the happy path appears to work in dev.

**How to avoid:**
- Persist `stripe_event_id` in a `processed_events` table with a UNIQUE constraint; check-then-insert atomically (use `INSERT ... ON CONFLICT DO NOTHING` or equivalent) BEFORE doing any side effect
- Only act if the insert succeeded (event was new)
- Use a dedicated table, not Redis-only, so a server restart doesn't cause re-processing
- All side effects (provisioning, DB writes, email sends) MUST be idempotent themselves — design downstream actions assuming they could run twice
- Webhook handler returns 200 within 5 seconds; offload heavy work to a queue (Stripe expects fast acks; slow handlers cause timeouts which cause MORE retries)
- Use Stripe CLI `stripe listen --forward-to localhost` and manually trigger duplicate deliveries during testing
- Never rely on signature uniqueness as idempotency — same event, same signature

**Warning signs:**
- A subscription event in Stripe dashboard shows multiple delivery attempts — verify your handler responded 200 each time and didn't cause side effects each time
- User reports "I paid but I'm not Pro" or "I'm being charged twice"
- Webhook latency p99 > 5 seconds — retries are imminent

**Phase to address:**
**Phase 4** — billing layer. Idempotency-guard pattern must be the FIRST thing implemented in the webhook handler, before any business logic.

---

### Pitfall 6: Stale principles match wrong context and inject incorrect warnings

**What goes wrong:**
A user has a principle in their EE: `Use IMLog<T>, never ILogger<T>` (correct for muonroi ecosystem). They start working on a non-muonroi project — a side project, a client codebase, an open-source contribution. The PreToolUse hook fires before an Edit, the EE matches the principle (because the embedding similarity is high — both involve logger calls), and injects `⚠️ [Experience] Use IMLog<T>`. The agent tries to follow it. The non-muonroi project doesn't have IMLog. The agent writes broken code. The user doesn't know why.

**Why it happens:**
Principles are stored as embeddings + payload, queried by semantic similarity. Without explicit project/repo scoping, "logger" is "logger" everywhere. The EE has no way to know that THIS edit is in a different codebase than where the principle was learned. The user's directive in CLAUDE.md ("Always IMLog<T>, never ILogger<T>") was correct but ecosystem-bound.

**How to avoid:**
- Every principle MUST carry a SCOPE in its payload: `{global, ecosystem:muonroi, repo:specific-path, branch:specific}`
- The PreToolUse hook query MUST filter by current `cwd` + `git remote` to determine which scopes apply
- Default scope at principle creation = repo-specific; promotion to ecosystem-scope or global-scope is explicit, judged by the cold-path judge worker
- A principle that has NEVER been confirmed outside its origin repo cannot match queries from other repos
- Principle store UI must show scope clearly so users can audit "why did this fire?"
- The `⚠️ [Experience]` warning should display the matched principle's scope so the agent (and user) can sanity-check

**Warning signs:**
- A user reports `⚠️ [Experience] Use IMLog` firing in a non-muonroi project — exactly the case from CLAUDE.md memory
- The same principle matches >80% of edits across multiple repos — too generic, scope is wrong
- Feedback API shows high `followed: false` rate for a single principle ID — it's matching wrong contexts

**Phase to address:**
**Phase 1** — when EE PreToolUse hook integration is wired. The scope payload schema must be fixed in Phase 1 because retrofit means re-tagging every existing principle, which is data-migration painful and lossy.

---

### Pitfall 7: Local→cloud EE migration loses or duplicates principles

**What goes wrong:**
A free user has been running for 3 months and accumulated 240 principles in local Qdrant. They upgrade to Pro. Migration runs. Either: (a) some principles are skipped (embedding upload failed silently, the user notices their agent is dumber), or (b) principles are duplicated (idempotent re-run inserted them twice, the user's principle count balloons, dedup fires later and merges arbitrarily). The IDEA explicitly calls out: *"Migration path required: local EE → cloud EE without principle loss"* — this is a locked constraint.

**Why it happens:**
- Migration is a one-shot operation rarely re-tested after initial implementation
- Network failures mid-migration leave an ambiguous state (some uploaded, some not)
- Embedding regeneration on the cloud side can produce different vectors (different model version), making dedup unreliable
- Local Qdrant schema may have evolved past what the cloud expects

**How to avoid:**
- Migration is **transactional at the principle level**: each principle has a stable `principle_uuid` set at creation, used as the deduplication key
- Migration is **resumable**: if it fails at principle 100/240, restart picks up from 101
- Migration runs in **mirror mode first**: principles are copied to cloud while local stays authoritative; only after successful verification (count match + checksum match) does the cut-over happen
- After cut-over, local Qdrant goes into read-only "archive" mode for 30 days — user can revert if cloud is broken
- Embedding model version is recorded per-principle; cloud uses the same model OR re-embeds with a feature flag
- Migration script has a `--dry-run` that produces a diff (would-add, would-skip, would-conflict)

**Warning signs:**
- A migrated user reports `⚠️ [Experience]` warnings stop firing for known patterns (lost principles)
- Cloud principle count > local principle count + recent additions (duplicates)
- Mid-migration crash leaves a user unable to use either local or cloud (no rollback path)

**Phase to address:**
**Phase 4** — but the `principle_uuid` field and stable schema must be set in **Phase 1** when EE PreToolUse hook is wired. Otherwise Phase 4 has no key to dedup on.

---

### Pitfall 8: Warm path (Ollama VPS) becomes single point of failure for ~8% of calls

**What goes wrong:**
The 3-tier router routes ~8% of calls to Ollama on the VPS (`72.61.127.154`). The VPS goes down — disk full, OOM, qwen2.5-coder process crashed, network partition. The router still tries warm-path. Every call times out at 10s. The product feels broken. The fallback to cold-path was never written because warm-path "always works." Or worse, the router silently downgrades EVERY call to cold-path — SiliconFlow gets hammered, latency spikes, costs jump because cold-path is paid.

**Why it happens:**
- The VPS is sunk-cost infrastructure used by the maintainer for other services — single host, no redundancy
- Ollama is a single-process binary with known Windows GPU detection issues that occasionally crash; on Linux VPS it's more stable but still a single point
- "Free local LLM" looks like infinite-availability infrastructure but it's not
- The router was tested in a happy-path scenario where Ollama responded — failure modes weren't fuzzed

**How to avoid:**
- Health-check Ollama every 30s; cache the health state with a 60s TTL
- Router decision: if health-check is `down`, skip warm-path entirely → either re-classify-down to a smaller cold-path model, or surface to user "running on degraded brain"
- Define an explicit SLO: "warm path responds <2s for >95% of requests"; alert when violated
- Cold-path fallback must NOT be silent — emit a status-bar indicator that warm-path is unavailable so users understand cost will be higher
- If the VPS is shared, Ollama runs in its own systemd unit with `Restart=on-failure` and resource limits so a runaway model doesn't take down other services
- Have an alternate warm-path option (a second VPS, or local Ollama on the user's machine if they opted in) — single warm path is fragile

**Warning signs:**
- Cold-path call volume spikes from ~2% to >10% — warm path is dying
- Latency p95 on warm-path > 1s — Ollama is thrashing CPU/memory
- Tool-call timeouts in user reports cluster around specific timestamps (correlated to VPS issues)

**Phase to address:**
**Phase 1** — when 3-tier router is built. Health-checks and fallback are not optional.

---

### Pitfall 9: Streaming aborted mid-tool-use leaves dangling state

**What goes wrong:**
The agent is mid-tool-call. The user hits Ctrl+C, or the network drops, or the provider rate-limits us mid-stream. Our state: a tool call was sent to the model, the model started responding with a tool invocation, it streamed half the JSON, and the stream died. The agent's internal state thinks "I have a pending tool call." On retry/resume, we re-issue the same prompt and the model produces a NEW tool call. The old half-streamed call is somewhere — never cleaned up. Worse: the tool call was a `write_file` and we already wrote a partial file before the abort.

**Why it happens:**
- Streaming + tool-use is fundamentally stateful in a way that vanilla chat completions are not
- AI SDK v6 streaming protocol uses SSE with reconnect capabilities, but the application-level state machine isn't automatically resumed
- The amputated `grok-cli` code may have abort handling that assumes a specific tool-use shape; our multi-provider adapter introduces NEW shapes that didn't exist when that code was written
- File writes / shell exec tools are NOT idempotent by default

**How to avoid:**
- Every tool call carries a stable `call_id` (UUID generated client-side, separate from provider IDs)
- Maintain a `pending_calls` log on disk; on startup, reconcile pending calls — for write/exec tools, prompt user "this tool call was interrupted, [resume / abort / mark-complete]"
- Tool implementations stage their work (write to `.tmp`, then atomic rename) so an abort doesn't leave half-written files
- AbortController is wired through the entire stack — model call → tool exec → file IO — and on abort, all are torn down in order
- The agent loop on resume reads `pending_calls`, marks them aborted, and instructs the next model turn that "the previous tool call was cancelled, do not assume it succeeded"

**Warning signs:**
- Files in the user's repo with `.tmp` or `.partial` suffixes after a Ctrl+C
- Agent on resume continues as if a previous tool call succeeded (it didn't)
- Multiple `write_file` calls on the same path within seconds of each other (retry-without-cleanup loop)

**Phase to address:**
**Phase 0** — abort handling is in the agent loop replacement (`src/agent/agent.ts` → EE+QC+GSD orchestrator) which is a Phase 0 deliverable. Cannot be retrofitted because tool implementations must be written staged-from-day-1.

---

## Moderate Pitfalls (MEDIUM severity)

### Pitfall 10: Token counter drift between provider and local count

**What goes wrong:**
Anthropic's response says `usage.input_tokens: 4823, output_tokens: 1241`. Our tokenizer counted 4801 input. Drift of 0.5%. Over a month, with 100K calls, drift compounds; the user's monthly USD shown in the status bar doesn't match the Anthropic console. Trust erodes.

**Why it happens:**
Each provider tokenizes differently. Claude uses a different tokenizer than GPT. Our local count is at best an estimate. The provider's count is authoritative but only known POST-call.

**How to avoid:**
- Local count is for `pre-call` budget reservation (worst-case, deliberately overcounts by ~5%)
- Provider count is what's recorded in the spend ledger AFTER the call
- Status bar shows "estimated" until the provider count returns, then reconciles
- Display a one-line note: "Provider's billing may differ by ~5% from this estimate; reconciled at end of session"

**Warning signs:**
- End-of-month reconciliation shows >5% drift between our total and provider invoice — tokenizer is wrong, not just estimating
- Users compare our display to their Anthropic console and report mismatches

**Phase to address:**
**Phase 0** — Usage Guard reservation ledger.

---

### Pitfall 11: Hot-path classifier overfits and misroutes novel tasks

**What goes wrong:**
The local heuristic classifier (regex/AST patterns) is trained on common task shapes. A user asks something genuinely novel ("refactor this distributed lock implementation to use Redis Lua"). The classifier matches `refactor` → routes to warm-path → qwen2.5-coder 7b drops the ball → user gets a wrong answer. Should have been cold-path. The user blames the product, not understanding routing.

**Why it happens:**
Heuristic classifiers by definition overfit to the patterns they've seen. Novel tasks are exactly the case where escalation matters most.

**How to avoid:**
- Classifier outputs a CONFIDENCE score, not just a tier
- Confidence < threshold → escalate to next tier regardless of pattern match
- A/B drift detection: periodically (1% sample) run a hot-routed call ALSO through cold-path; compare quality (judge worker rates both); if hot-path is consistently worse on a pattern, retrain the classifier or add an exception
- Manual override available to user: `/route cold "refactor distributed lock"` forces cold-path
- Classifier patterns are versioned and can be rolled back

**Warning signs:**
- Judge worker's quality score on hot-path calls trends downward over time
- User feedback / re-prompts spike for specific task types (signal: classifier got those wrong)
- Same prompt routed differently on different invocations (classifier non-determinism — pattern conflicts)

**Phase to address:**
**Phase 1** — classifier is part of the 3-tier router build.

---

### Pitfall 12: Auto-downgrade chain causes visible quality regression mid-task

**What goes wrong:**
User is mid-debugging-session with Opus. Hits 80% threshold. Router downgrades to Sonnet. The next response is noticeably worse — Sonnet doesn't connect the dots Opus did. User notices, gets confused, blames the product. The downgrade was correct policy but the experience was jarring.

**Why it happens:**
Models have very different response qualities. A mid-task downgrade breaks the user's mental model of "the agent is consistent." Cap thresholds (50%/80%/100%) are designed for end-of-month, not mid-session.

**How to avoid:**
- Show DOWNGRADE EXPLICITLY in the status bar before it happens: "Approaching cap — next call will use Sonnet instead of Opus. [Continue / Stop / Increase Cap]"
- Allow user to pause at the threshold and manually decide
- For TASK-CONTINUITY: if the user is mid-task (defined by `.muonroi-flow/` artifact state = active phase), prefer "halt and ask" over silent downgrade
- Downgrade chain documented in `--help` so it's not a surprise
- After downgrade, status bar shows "running on degraded model — [why]" persistently

**Warning signs:**
- Users report "the agent suddenly got dumber" — likely silent downgrade
- Support tickets cluster around 80%-of-cap timing
- Users disabling Usage Guard entirely (worst outcome — they want quality, we forced quantity)

**Phase to address:**
**Phase 0** — Usage Guard threshold UX. The mechanism is mandatory in Phase 0 per IDEA.

---

### Pitfall 13: Compaction skill drops content the next phase actually needs

**What goes wrong:**
QC compaction triggers at a "safe checkpoint" (between phases). It summarizes earlier turns aggressively. Three turns later, the agent needs to recall a specific decision from compacted history ("we agreed to use X library"). The summary said "discussed library options" — lost the conclusion. Agent picks a different library. Inconsistency.

**Why it happens:**
Compaction is by design lossy. The "safe checkpoint" assumption is that the user's run-artifact captures decisions, but in practice many decisions live only in chat. QC's deliberate compaction is better than provider auto-compaction but not magic.

**How to avoid:**
- Compaction runs in TWO PASSES: (1) extract decisions/facts/constraints into the run artifact (`.muonroi-flow/decisions.md`), (2) only THEN compact the chat
- Run artifact becomes the authoritative source for "what did we decide" — chat is conversational fluff
- Agent loop reads from run artifact at the start of every new phase, not from chat memory
- User can mark turns as "preserve verbatim" — compaction respects the marker
- Compaction is REVERSIBLE: full history is retained on disk, only the active context is compacted; user can `/expand` to bring a section back

**Warning signs:**
- Agent contradicts a decision made earlier in the session
- User says "we already discussed this" — compaction lost the discussion
- Run artifact `decisions.md` is empty after a long session — extraction step isn't working

**Phase to address:**
**Phase 2** — QC compaction is a Phase 2 deliverable. The two-pass design must be the initial implementation, not a v2.

---

### Pitfall 14: `.muonroi-flow/` artifact paths conflict with `.planning/` or `.experience/`

**What goes wrong:**
The user's repo already has `.planning/` from GSD, `.experience/` from EE, and now we add `.muonroi-flow/`. Three top-level dot-directories in every repo. Some users will already have a `.muonroi-flow/` from an earlier experiment with the same name. Or the file names inside collide (e.g., both `.planning/STATE.md` and `.muonroi-flow/STATE.md`).

**Why it happens:**
Naming collisions in convention-over-config systems are inevitable. Solo maintainer doesn't notice because they personally manage all three.

**How to avoid:**
- Single root: `.muonroi/` containing subfolders `flow/`, `planning/`, `experience/` — one dot-directory per project
- OR: distinct prefixes that won't collide (`.muonroi-flow/`, `.muonroi-planning/`, `.muonroi-experience/`)
- Detect existing directories on first run; offer migration or coexistence
- Document the naming clearly in README; add to `.gitignore` template
- All artifact paths configurable via `~/.muonroi/config.toml` — defaults work, power users can rename

**Warning signs:**
- Users open issues about "what is this directory" — naming isn't self-explanatory
- Existing GSD projects break when muonroi-cli runs in them
- File explorer in TUI shows confusing nested dot-directories

**Phase to address:**
**Phase 2** — when `.muonroi-flow/` is created. Decide naming once before any user adopts it.

---

### Pitfall 15: License attribution drift after fork

**What goes wrong:**
The fork starts with `grok-cli`'s LICENSE (MIT, attribution to Vibe Kit). Three months in, we've added our own code, refactored everything, and the LICENSE file gets edited to "Copyright muonroi". Vibe Kit's attribution disappears. We're now in MIT violation. They notice, send a takedown / DMCA, and the project eats a public legal black eye.

**Why it happens:**
- LICENSE files get edited during refactor without thinking
- "It's all rewritten now" is wrong — MIT requires retention even of inspiration
- The IDEA's hard constraint says "Fork must preserve `grok-cli` MIT attribution to Vibe Kit" but that's a constraint, not a CI check

**How to avoid:**
- Keep the original `grok-cli` `LICENSE` file as `LICENSE-grok-cli` (or `LICENSES/grok-cli.txt`)
- Our own code under our own `LICENSE` (TBD: MIT, AGPL, commercial-source-available — DECISIONS.md item)
- README has a "Acknowledgments" section pointing to upstream
- CI check: if `LICENSES/grok-cli.txt` is removed or modified in a PR, fail
- Before any public release, run a `licensee` or equivalent OSS license scanner
- Document derivative-work boundaries — files heavily based on grok-cli get a `// Adapted from grok-cli (MIT, Vibe Kit)` header

**Warning signs:**
- Pre-release license scan flags missing attribution
- A maintainer in Vibe Kit's space comments on a public repo issue
- Our README never mentions the fork — red flag for transparency

**Phase to address:**
**Phase 0** — license preservation is part of the fork commit per IDEA constraint.

---

### Pitfall 16: Bun on Windows native module ABI mismatch breaks installs

**What goes wrong:**
We ship muonroi-cli as `npm install -g muonroi-cli` (or equivalent). User on Windows runs install. A dependency uses a native module (`better-sqlite3`, `node-pty`, `keytar`). Bun and Node have DIFFERENT NODE_MODULE_VERSION ABI numbers (Bun is 141, Node varies); the binary compiled against one cannot load in the other. Install completes, runtime crashes with `LoadLibrary failed` or DLL initialization errors. User on Windows 11 Enterprise reports it works on macOS but not Windows.

**Why it happens:**
- Bun on Windows is younger and has more rough edges than on Linux/macOS
- Native modules from npm registry are Node-ABI-compiled by default; Bun rebuilds them with its own ABI but the rebuild can fail silently on Windows
- Some packages have prebuilt binaries for Node only

**How to avoid:**
- Prefer Bun's BUILT-IN equivalents over npm-native modules: `bun:sqlite` over `better-sqlite3`, Bun's child_process over `node-pty` where possible
- Where a native module is unavoidable, check upstream Bun compatibility BEFORE adding the dep — search GitHub issues
- Ship with Bun's `bun build --compile` to produce a single executable that bundles a known-good runtime; don't rely on user-installed Bun version
- Test matrix in CI: Windows 10 + Windows 11 + macOS + Linux — all four must pass before a release
- If a Windows-specific bug surfaces, document the workaround in README before release; don't ship a known-broken Windows build

**Warning signs:**
- Beta tester on Windows reports install completes but `muonroi-cli` won't start
- Bun GitHub issues show recent regressions on Windows in versions you've pinned
- macOS works, Windows doesn't, after a dependency bump

**Phase to address:**
**Phase 0** (validate) + **Phase 3** (CI matrix).

---

### Pitfall 17: Ollama on Windows GPU detection failures (for users running local warm-path)

**What goes wrong:**
We document an optional "run Ollama locally as your warm-path brain" path for offline-first users. User on Windows installs Ollama. Ollama doesn't detect their NVIDIA GPU (driver mismatch, RTX 5090 Blackwell support, Ollama installed before driver, etc.). Ollama silently falls back to CPU. A 7B model now runs at 3-8 tokens/sec instead of 40-80. User says "muonroi-cli is unusably slow." We get blamed for an Ollama configuration issue.

**Why it happens:**
- Ollama Windows GPU detection is documented-flaky (RTX 5090 Blackwell sm_120 support incomplete; 0.13.x intermittent detection issues; install-order matters)
- "Falls back to CPU" is a silent degradation — no error, just slow
- Users don't read Ollama's install docs; they treat it as a turnkey download

**How to avoid:**
- On startup, query Ollama's `/api/ps` and check if loaded models report GPU usage; if CPU-only, surface a banner "Ollama is running on CPU — performance will be 5-10x slower; see [URL] for GPU setup"
- Document in our README: "If you opt into local Ollama, ensure NVIDIA drivers are installed BEFORE Ollama, and verify GPU usage with `ollama ps`"
- For users without compatible GPUs, recommend the VPS warm-path or cold-path-only mode — DON'T let them suffer silently
- Default config: use VPS warm-path (works for everyone); only opt-in to local Ollama with explicit `--ollama=local` or config flag

**Warning signs:**
- User reports "muonroi-cli is slow" when they recently enabled local Ollama
- Ollama logs in `%LOCALAPPDATA%\Ollama\logs` show "no GPU found"
- Bug report timeline shows GPU drivers updated after Ollama install

**Phase to address:**
**Phase 1** — when warm-path is wired, the GPU-detection-and-warn behavior is part of the warm-path adapter.

---

### Pitfall 18: Test coverage from upstream becomes irrelevant after amputation

**What goes wrong:**
`grok-cli` has tests for `src/grok/*` (deleted), `src/telegram/*` (deleted), `src/payments/*` (deleted), `src/agent/agent.ts` (rewritten). Our CI still runs them. Half pass (testing things we don't change), half fail (testing deleted modules), some "pass" because they test stubs that don't actually wire to anything. Coverage looks 60% but the tests test nothing useful. False confidence; real bugs ship.

**Why it happens:**
Deleting tests for deleted code feels destructive — easier to leave them and skip in CI. Tests that "still pass" feel like free coverage but they test the SHELL of code we kept, not our integration.

**How to avoid:**
- During fork cleanup, DELETE tests alongside their target code — `src/telegram/__tests__/` goes when `src/telegram/` goes
- Tests for code we modified (e.g., `src/agent/agent.ts`) are deleted and rewritten; they were testing the OLD behavior
- Coverage report is computed AFTER cleanup; baseline is what's left
- Add a CI check: any `.test.ts` whose import target doesn't exist fails the build
- Phase 3 polish includes a test-suite review — "every test serves a purpose"

**Warning signs:**
- Test names reference deleted modules or removed features
- Coverage reports show 80% but you don't believe it
- A real bug ships in code that has 100% line coverage (the tests test imports, not behavior)

**Phase to address:**
**Phase 0** (delete obsolete tests) + **Phase 3** (comprehensive test review).

---

### Pitfall 19: Currency conversion or pricing change mid-month breaks Usage Guard math

**What goes wrong:**
User configured cap = $15/month. Anthropic raises Sonnet input pricing by 20% mid-month. Our pricing table is hardcoded. Status bar still shows old prices. User hits cap silently because actual provider charges are higher than what we're tracking. End of month: user is over.

**Why it happens:**
Provider pricing IS opaque and CAN change with short notice. Hardcoded pricing tables become stale. Currency for international users (cap in USD but billing in EUR) adds another conversion layer.

**How to avoid:**
- Pricing table in a remotely-fetched JSON, with a fallback to bundled defaults
- On startup, fetch latest pricing from a known endpoint (our own server, or a cached registry); if fetch fails, use bundled with a "pricing data may be stale" warning
- Refresh pricing at session start AND every N hours during a long session
- Cap is in USD; display both USD and a converted local-currency estimate; reconciliation against provider invoice is in USD only
- Document that "your provider's actual charges may vary; this is an estimate"

**Warning signs:**
- A pricing change announcement from a provider — must update bundled defaults within 24 hours
- User reports cap exceeded after billing month ended
- Drift between displayed cost and provider dashboard > 5%

**Phase to address:**
**Phase 1** (pricing-table abstraction) + **Phase 4** (remote-fetch).

---

### Pitfall 20: Solo-maintainer support volume collapses when 100 users hit the same bug

**What goes wrong:**
Beta launches. 100 users sign up. A bug surfaces (specific to a Bun version, or a Windows config, or a provider edge case). 30 users open issues in 24 hours. Solo maintainer is the only triager. User trust collapses while the maintainer is asleep.

**Why it happens:**
- Solo-maintainer constraint is real but doesn't scale with user count
- Beta users have low patience; they assume someone is on the other end
- Without templates, every issue is a from-scratch investigation

**How to avoid:**
- Issue templates that REQUIRE: OS, Bun version, muonroi-cli version, provider, redacted logs, reproduction steps
- An automated bug-report bundle command: `muonroi-cli bug-report` collects all the above (with key redaction) into a paste-able blob
- Diagnostic "self-check": `muonroi-cli doctor` runs known-issue heuristics (Bun on Windows? Ollama GPU? Stale dependency?) and reports
- Cap beta enrollment by gradient — 10 users week 1, 30 week 2, 100 by month 1; pause if response time blows out
- Status page (even a simple `STATUS.md`) for outages

**Warning signs:**
- Inbox of duplicates within hours of a release
- Same question asked 5 times — needs to be in FAQ or doctor
- Maintainer burnout signals (response time growing, quality dropping)

**Phase to address:**
**Phase 3** — beta-prep. Issue templates and `doctor` command must ship with beta launch.

---

## Minor Pitfalls (LOW severity — but document for awareness)

### Pitfall 21: Provider key revocation invalidates cached sessions silently

**What goes wrong:**
User rotates their Anthropic key (security best practice). Our adapter has cached the old key in memory for the running session. Next call: 401. The agent loop sees an opaque "unauthorized" error and may retry-loop, may halt confused.

**How to avoid:**
- On 401 from a provider, IMMEDIATELY purge the cached key and prompt user to re-enter (or re-read from keychain)
- Distinguish 401-key-revoked from 401-rate-limit-as-401 (some providers do this); read response headers
- `muonroi-cli config rotate-key <provider>` command for graceful rotation

**Phase:** Phase 1.

---

### Pitfall 22: Provider rate-limit errors surface as product errors

**What goes wrong:**
User hits Anthropic's per-key tier-1 rate limit. Anthropic returns 429. Our agent surfaces "request failed" — user blames muonroi-cli, not their account tier.

**How to avoid:**
- Catch 429s; surface "your provider has rate-limited your key — wait N seconds (per `Retry-After` header), or upgrade your provider tier"
- Implement exponential backoff for 429 with a max of 3 retries before bubbling up
- Status bar shows "rate-limited by provider" persistently while throttled

**Phase:** Phase 1.

---

### Pitfall 23: User upgrades plan but key state doesn't migrate

**What goes wrong:**
User upgrades Free → Pro. The keychain still has their key from Free tier. Pro tier introduces NEW provider options (e.g., a Pro-tier proxy). Old config persists, new options are inaccessible until manually configured.

**How to avoid:**
- Tier-change triggers a config-migration step that runs once
- New config keys default to sensible Pro values
- `muonroi-cli config validate` checks for inconsistent state and offers fix

**Phase:** Phase 4.

---

### Pitfall 24: Routing decision itself becomes expensive

**What goes wrong:**
The hot-path classifier is supposed to be free (regex/AST patterns). Someone "improves" it by calling a small remote model for tough classifications. Now every routing decision costs 50ms + a fraction of a cent. At scale, the routing layer costs more than the saved tokens.

**How to avoid:**
- Hot-path is HARD CONSTRAINED to be local + sub-1ms — enforced by an arch test that runs in CI
- Any improvement that adds a network call MUST be tagged as warm-path or cold-path, never hot-path
- Profile routing decision latency in observability — alert if p99 > 5ms

**Phase:** Phase 1.

---

### Pitfall 25: Hook latency bleeds into every tool call

**What goes wrong:**
EE PreToolUse hook fires before Edit/Write/Bash. It queries Qdrant, runs match logic, formats output. If it takes 200ms per call, and a session has 500 tool calls, that's 100 seconds of pure overhead. User notices the agent feels "laggy."

**How to avoid:**
- Hook has a hard latency budget: <50ms p99
- Qdrant query is local (Phase 0-3) so it's fast; cloud (Phase 4) needs caching
- Hook results cached by `(cwd, tool, args-hash)` for short TTL (5 min) — repeated identical calls don't re-query
- If hook exceeds budget, log + skip; don't block the user

**Phase:** Phase 1.

---

### Pitfall 26: AI SDK becomes incompatible at v7

**What goes wrong:**
We pin AI SDK v6. Six months later AI SDK v7 ships. v6 stops getting bug fixes. v7 has new breaking changes. We either eat the migration cost or accumulate technical debt.

**How to avoid:**
- Wrap AI SDK behind our own multi-provider adapter — already part of the plan
- The adapter exposes a STABLE internal interface; AI SDK migration is a one-place change, not a ripple
- Track AI SDK release cadence in `UPSTREAM_DEPS.md`
- Don't migrate eagerly — wait for v7.1 or v7.2 to settle, but plan for it

**Phase:** Phase 1 (adapter design) for prevention; Phase 4+ for migration.

---

### Pitfall 27: Cursor/Claude Code releases the same feature for free

**What goes wrong:**
We're 8 weeks into the build. Anthropic ships "Claude Code Brain" with cross-session memory and per-call routing. Our differentiator collapses. Users have no reason to BYOK when the subscription tool now does the same.

**How to avoid:**
- This is a strategic risk, not a technical one — cannot be fully mitigated
- BYOK + multi-provider + offline-first remains a moat even if competitors add memory
- Faster ship is the best defense — 6-8 week target is aggressive, hold to it
- Public roadmap signals where we're heading; community + word-of-mouth is the moat after launch

**Phase:** Always — strategic awareness throughout.

---

### Pitfall 28: A model provider deprecates an API our adapter relies on

**What goes wrong:**
We support OpenAI's chat completions API. They deprecate it in favor of Responses API. Our adapter is broken for OpenAI users.

**How to avoid:**
- Adapter abstracts the call shape — we map our internal interface to whatever each provider currently supports
- Subscribe to provider deprecation announcements; treat them as P1 issues
- Have at least 6 months of migration runway between deprecation announcement and our adapter switch

**Phase:** Phase 1 (adapter design) for prevention; ongoing maintenance forever.

---

### Pitfall 29: Open-source competitor (Aider, Continue.dev) catches up on principle persistence

**What goes wrong:**
A free OSS tool ships persistent memory better than ours. Pro tier ($9/mo) has a hard sell.

**How to avoid:**
- Pro value isn't ONLY persistent memory — it's cloud sync, governance, multi-machine, audit
- Free tier should remain genuinely useful — don't artificially gimp it; let competitive pressure improve quality
- Differentiation through QC (run-artifact continuity, deliberate compaction) and Usage Guard (hard cap) — fewer competitors there

**Phase:** Always — strategic positioning.

---

### Pitfall 30: Judge worker produces junk principles that pollute the store

**What goes wrong:**
Cold-path judge worker auto-generates principles from hot-path A/B failures. Some are spurious — overfit, contradictory, or just wrong. They get inserted into the principle store. Future hook queries match them and inject bad warnings. Users develop distrust ("the warnings are useless, I disable them").

**How to avoid:**
- Judge-generated principles are tagged `confidence: low` initially
- Principles must be CONFIRMED (matched in N independent contexts and followed-correctly) before being promoted to high-confidence
- User-visible principle review UI: "this principle has fired 12 times, marked unhelpful 9 — delete?"
- Feedback API integration: when an injected hint is marked `followed: false`, principle confidence decays
- Periodic store-pruning: principles below a confidence threshold and unmatched for 30 days are auto-archived

**Phase:** Phase 1 (confidence schema) + Phase 2 (pruning logic).

---

---

# v1.1 EE-Native CLI Milestone Addendum

**Milestone:** EE-Native CLI restructure — importing `experience-core.js` (pure CJS, zero npm deps, Node 20+) directly into a Bun ESM codebase, unifying config systems, sharing a Qdrant client, wiring a deterministic auto-judge feedback loop, and doing so without breaking EE's sidecar mode.
**Researched:** 2026-05-01
**Confidence:** HIGH for module-format and config pitfalls (verified in codebase + confirmed against Bun docs). MEDIUM for feedback-loop deadlock patterns (verified via ag2/Claude Code PostToolUse docs). MEDIUM for Qdrant client sharing (verified against Qdrant REST client design).

---

## Critical Pitfalls — EE-Native Integration

### Pitfall 31: CJS `module.exports` shape is not the same as an ESM named export

**What goes wrong:**
`experience-core.js` uses `module.exports = { intercept, routeModel, routeFeedback, ... }` — a CJS object-bag export with 60+ functions. When an ESM file does `import { intercept } from './experience-core.js'`, Bun's CJS-in-ESM interop wraps the exports object as the default. Named import `{ intercept }` fails at runtime with `undefined` unless the CJS module explicitly sets `__esModule: true`, which `experience-core.js` does NOT do. The import silently succeeds at TypeScript compile time (because `esModuleInterop: true` is in tsconfig) but the destructured `intercept` is `undefined` at runtime.

**Why it happens:**
`esModuleInterop: true` in tsconfig makes TypeScript happy at compile time and adds a synthetic default wrapper. But at runtime in Bun, when you `import X from './foo.cjs'`, you get the `module.exports` object as `X`. When you `import { intercept } from './foo.cjs'` with no `__esModule`, Bun returns `undefined` for the named import because the CJS module has no live named export bindings — only a `module.exports` bag. The TypeScript types compile cleanly because they're generated from the shape, not from the runtime binding semantics.

**How to avoid:**
- Always import as default: `import coreModule from './experience-core.js'` then destructure in TS: `const { intercept, routeModel } = coreModule`
- OR: write a thin ESM wrapper `src/ee/core-shim.ts` that does `import core from '../../experience-engine/.experience/experience-core.js'; export const { intercept, routeModel, routeFeedback } = core as typeof core;` — all call sites import from the shim
- The shim approach is strongly preferred: it is the only stable boundary, it can be typed, and it is the place to version-guard if experience-core.js's export shape changes
- Add a smoke test: `import { intercept } from './core-shim.js'; assert(typeof intercept === 'function')`

**Warning signs:**
- TypeScript compiles cleanly but `intercept(...)` throws `TypeError: intercept is not a function` at runtime
- Destructured functions work at the module level but arrive as `undefined` inside an async function (module evaluation order issue)
- `console.log(intercept)` in a test file prints `undefined` even though the import has no TS error

**Phase to address:**
**v1.1 Phase 1** — the CJS shim must be the very first thing created before any call sites are written.

---

### Pitfall 32: `experience-core.js` reads `~/.experience/config.json` at require-time; EE config and CLI config diverge silently

**What goes wrong:**
`experience-core.js` loads `~/.experience/config.json` as a singleton at module load time (verified in source: `loadConfig()` initializes on first `getConfig()` call with mtime-based cache). The CLI loads `~/.muonroi-cli/config.json` separately. The user sets the Qdrant URL in `~/.muonroi-cli/config.json` to point at their VPS (`http://72.61.127.154:6333`). `experience-core.js` still reads `~/.experience/config.json` where `qdrantUrl` defaults to `localhost:6333`. The CLI's Qdrant queries hit the VPS; EE's internal Qdrant queries hit localhost. Principles written by EE are in a different Qdrant instance than what the CLI reads. Data split — never surface-level visible, just wrong results.

**Why it happens:**
Two independently-designed config systems with no cross-reading protocol. The maintainer operates both and keeps them in sync manually; a user would not know to configure `~/.experience/config.json` separately. The EE config is loaded at `require()` time so it cannot be injected from the CLI config without a process-start hook.

**How to avoid:**
- At CLI startup, BEFORE requiring `experience-core.js`, read `~/.muonroi-cli/config.json` and write the EE-relevant fields (`qdrantUrl`, `qdrantKey`, `ollamaUrl`, `brainProvider`, `embedProvider`) to `~/.experience/config.json` — or set the corresponding `EXPERIENCE_*` env vars which `experience-core.js` reads as fallback
- The env-var path is cleaner and avoids touching the user's EE config file from a different tool
- Env vars are scoped to the process; no cross-contamination between EE-as-sidecar and CLI-as-direct-importer
- Required env-var mapping: `EXPERIENCE_QDRANT_URL`, `EXPERIENCE_QDRANT_KEY`, `EXPERIENCE_OLLAMA_URL`, `EXPERIENCE_BRAIN_PROVIDER`, `EXPERIENCE_EMBED_PROVIDER` — all read by `cfgValue()` in `experience-core.js` as second-priority after config.json

**Warning signs:**
- `/health` returns Qdrant OK but CLI-side Qdrant queries return empty results (wrong instance)
- Principle count visible in EE's `exp-stats` command doesn't match what the CLI shows for the same user
- User sets a custom Qdrant URL in CLI config but EE still connects to localhost

**Phase to address:**
**v1.1 Phase 1** — config bootstrap must happen before the first `require()` of experience-core.js.

---

### Pitfall 33: Shared `@qdrant/js-client-rest` across EE and CLI creates dual-connection overhead and version mismatch risk

**What goes wrong:**
The CLI has `@qdrant/js-client-rest@1.17.0` in its `package.json`. `experience-core.js` uses Node's native `fetch` directly to call Qdrant REST endpoints — it has ZERO npm dependencies, verified in source. When the CLI's EE shim imports `experience-core.js` and ALSO creates its own `QdrantClient` instance for PIL Layer 3 searches, there are now TWO independent HTTP connection sets to the same Qdrant instance. This is not catastrophic, but it is wasteful (two keep-alive pools, two auth headers) and can cause subtle ordering issues if one client's write is not yet visible to the other client's immediate read.

**Why it happens:**
The CLI's `@qdrant/js-client-rest` was added to support PIL Layer 3 (`/api/search`) before the EE-native restructure was planned. Post-restructure, PIL Layer 3 can delegate to `experience-core.js`'s `searchCollection()` function directly, making the CLI's Qdrant client redundant for that path.

**How to avoid:**
- Post-restructure: remove the CLI's direct Qdrant client usage from PIL Layer 3 — route all Qdrant operations through `experience-core.js` functions
- Keep `@qdrant/js-client-rest` in the CLI's `package.json` ONLY if there are CLI-exclusive Qdrant operations (there currently are none post-restructure)
- If both clients must coexist temporarily, ensure they use the same `qdrantUrl` + `qdrantKey` by bootstrapping env vars before either is initialized
- Write-then-read consistency: if the CLI writes via EE's `syncToQdrant` and then immediately reads via a CLI-side client, add a retry with 50ms backoff — Qdrant REST indexing is near-instantaneous but not synchronous

**Warning signs:**
- Qdrant REST connection count doubles unexpectedly (visible in server metrics)
- A write via `experience-core.js` doesn't appear in a CLI-side `QdrantClient.search()` immediately after (ordering, not a race per se)
- `package.json` has `@qdrant/js-client-rest` but no direct import in the codebase after restructure

**Phase to address:**
**v1.1 Phase 2** — after PIL Layer 3 is migrated to EE-native search. Remove the redundant CLI Qdrant client in the same PR.

---

### Pitfall 34: EE sidecar mode breaks if CLI modifies `~/.experience/config.json` or Qdrant data during an EE server session

**What goes wrong:**
EE runs as a sidecar at `localhost:8082`. CLI restructures to call `experience-core.js` directly and — to resolve Pitfall 32 — writes EE config fields to `~/.experience/config.json`. The EE sidecar has already loaded this config at startup and caches it with mtime-based invalidation. If the CLI overwrites the config with slightly different values (e.g., it normalizes the Qdrant URL from `localhost:6333` to `http://localhost:6333`), the next mtime-change triggers a config reload in the EE sidecar mid-session. The EE sidecar's internal Qdrant URL changes. In-flight requests complete against the old URL; new requests use the new URL. For a single-user local setup this is harmless, but if the CLI is writing `config.json` on every startup, this creates unnecessary config-file churn and mtime drift.

**Why it happens:**
The EE config file is a shared mutable resource. The CLI and the EE sidecar both read it. Writing it from the CLI — even with the same values — touches mtime and triggers a reload.

**How to avoid:**
- Use env vars (`EXPERIENCE_*`) for CLI-specific Qdrant overrides, NOT config file writes — env vars are process-scoped and invisible to the EE sidecar
- If config-file writing is unavoidable, write only ONCE on first run and only if the value is different from what's already in the file — implement a "merge and write only on diff" pattern
- The CLI must never overwrite EE config fields that the user set deliberately (e.g., `brainModel`, `embedModel`) — only inject fields that are missing
- Document the config hierarchy clearly: EE config (`~/.experience/`) is EE-owned; CLI config (`~/.muonroi-cli/`) is CLI-owned; overlapping fields are bridged via env vars

**Warning signs:**
- EE sidecar logs show `config reloaded` timestamps matching CLI startup times
- A user changes `brainModel` in `~/.experience/config.json` but the CLI overwrites it on next start
- EE `/health` reports Qdrant OK but mid-session queries fail (URL was changed by CLI during sidecar session)

**Phase to address:**
**v1.1 Phase 1** — config bridge strategy must be decided before any code that writes `~/.experience/config.json`.

---

### Pitfall 35: Ollama cold-start latency (5-30s) blocks the orchestrator hot path during EE brain calls

**What goes wrong:**
EE's `classifyViaBrain()` calls Ollama to classify task intent. In the EE-native restructure, the CLI calls this function directly (no HTTP sidecar buffering). On first call after model idle timeout (Ollama default: 5 min), Ollama unloads and reloads the model. This cold-start takes 5-30s depending on model size and hardware. The orchestrator is blocked waiting for the classification result. The user's TUI appears frozen. If the existing 200ms PIL pipeline timeout fires first, the pipeline fails open — but the blocking call is still in progress in the background, consuming resources and eventually returning to nobody.

**Why it happens:**
Via the HTTP sidecar, the EE server had its own timeout budget and circuit breaker. When `experience-core.js` is called in-process, there is no HTTP circuit breaker. `classifyViaBrain()` makes an internal fetch to Ollama with no timeout — or with Ollama's default 30s request timeout which is far too long for a hot path.

**How to avoid:**
- Wrap ALL `experience-core.js` brain calls with `AbortSignal.timeout(N)` where N matches the calling layer's budget: 200ms for PIL hot path, 2s for router warm path, 10s for async judge
- The EE-native shim `src/ee/core-shim.ts` must expose timeout-aware wrappers, not bare function re-exports
- Example pattern: `export async function classifyViaBrainWithTimeout(text: string, timeoutMs: number): Promise<ClassifyResult | null> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await core.classifyViaBrain(text, { signal: controller.signal }); } catch { return null; } finally { clearTimeout(timer); } }`
- If `classifyViaBrain` does not accept an AbortSignal, wrap with `Promise.race([call(), rejectAfter(timeoutMs)])`
- Warm the Ollama model at CLI startup (send a no-op generation request) to avoid cold-start on the first real call

**Warning signs:**
- PIL pipeline regularly exceeds its 200ms budget and fails open — Ollama classification is blocking
- TUI spinner appears frozen for >1s during initial prompt processing
- `classifyViaBrain` returns a result after the pipeline timeout fired — the background call completed but the result was discarded

**Phase to address:**
**v1.1 Phase 1** — every EE brain call must have an explicit timeout before the first end-to-end test.

---

### Pitfall 36: Auto-judge feedback loop deadlocks when PostToolUse fires during an active EE function call

**What goes wrong:**
The auto-judge is designed as fire-and-forget: `fireFeedback()` in `src/ee/judge.ts` calls `client.feedback()` which hits `/api/feedback`. Post-restructure, if `fireFeedback()` calls `experience-core.js` functions directly (e.g., `recordFeedback()`), and `recordFeedback()` internally calls Qdrant, and the Qdrant call is concurrent with an active `intercept()` call that also has a Qdrant call in flight, there is NO deadlock at the JavaScript level (event loop is single-threaded, no mutex). However, there IS a logical race: the feedback for tool call N fires before the `posttool` call for tool call N completes, which means `reconcilePendingHints()` inside EE may run with stale state for N while N's judgment is being written. This produces a corrupted reconciliation — the principle's hit count is incremented, but the follow-count is credited to the PREVIOUS tool call's matches.

**Why it happens:**
The EE sidecar design serialized these operations via HTTP: `posttool` request body = all context needed; `feedback` request body = just the verdict. In-process, the calls share mutable in-memory state (last-suggestions cache) that the sidecar kept in a file (`last-suggestions.json`). The file-based design was intentionally single-writer (only `interceptor.js` writes, only `interceptor-post.js` reads). In-process, if `intercept()` and `fireFeedback()` run in overlapping async microtask turns, the ordering guarantee disappears.

**How to avoid:**
- Preserve the sidecar's serialization contract: `fireFeedback()` MUST NOT be called until `posttool()` has resolved. In the orchestrator, enforce: `await posttool(...)` completes before `fireFeedback()` is invoked. This is already the correct order in `src/ee/posttool.ts` — verify that no code paths fire feedback before posttool.
- Do NOT convert fire-and-forget to in-process synchronous calls — keep them fire-and-forget via `Promise.resolve().then(() => fireFeedback(...))` (next microtask tick) to maintain ordering guarantee
- Write a test: tool call → posttool → assert feedback fires AFTER posttool resolves, not before
- The `last-suggestions.json` file state machine should be replaced in-process with an equivalent in-memory `Map<callId, InterceptResponse>` with explicit lifecycle: set on intercept, read+delete on judge

**Warning signs:**
- Principle hit counts grow faster than expected (feedback fires before posttool state is cleared)
- Judge classification is consistently `IRRELEVANT` even for known-firing principles (the match context was cleared before judge ran)
- Two rapid tool calls show inverted feedback ordering in the EE activity log

**Phase to address:**
**v1.1 Phase 2** — when the full EE hook pipeline (PreToolUse → PostToolUse → Judge → Feedback → Touch) is being verified end-to-end.

---

## Moderate Pitfalls — EE-Native Integration

### Pitfall 37: `__dirname` and synchronous `require()` in `experience-core.js` behave differently under Bun than under Node

**What goes wrong:**
`experience-core.js` uses `const fs = require('fs')`, `const path = require('path')`, and dynamic `require(crypto).randomUUID()` patterns. In Bun's CJS-in-ESM interop layer, these all work — Bun supports `require()` from ESM context and provides the Node builtins. However, Bun's `__dirname` in a CJS module loaded from an ESM entry point resolves relative to Bun's virtual bundle root, not the physical file path. If `experience-core.js` ever uses `__dirname` to build a path to adjacent files (e.g., `path.join(__dirname, 'judge-worker.js')`), the path resolves incorrectly and `spawn` fails silently on Windows.

**Why it happens:**
Bun's module resolution differs from Node's for CJS files loaded via `import()`. The `__dirname` value inside a CJS module loaded from an ESM context is implementation-defined in Bun — it typically matches the physical file path but Bun's behavior here is less well-documented than Node's. The judge-worker spawn path in `experience-core.js` (verified: uses `EXP_DIR = path.join(os.homedir(), '.experience')` not `__dirname`) is OK. But any NEW code added to the shim that tries to spawn from `__dirname` will break.

**How to avoid:**
- In the ESM shim (`src/ee/core-shim.ts`), never use `__dirname` to reference EE source files — always use `path.join(os.homedir(), '.experience', 'filename.js')` which is what EE itself uses
- For any spawn of Node workers from the CLI, use `process.execPath` (Node binary path from Bun) — Bun sets this correctly for spawned Node processes
- Smoke test: after loading the shim, verify that `experience-core.js`'s internal spawn of `judge-worker.js` resolves to an existing file path

**Warning signs:**
- `judge-worker.js` never runs (no feedback recorded) but no error is thrown — path resolution silently pointed nowhere
- Windows CI passes but macOS fails (or vice versa) after adding any `__dirname`-based path in shim code
- EE activity log shows `op: hook, hook: interceptor-post` entries but no corresponding judge outcomes

**Phase to address:**
**v1.1 Phase 1** — verify in smoke test immediately after wiring the shim.

---

### Pitfall 38: Bun's `node:child_process.spawn` with `detached: true` may not fully detach on Windows

**What goes wrong:**
`experience-core.js`'s judge worker is spawned detached via `spawn(process.execPath, [judgeWorkerPath], { detached: true, stdio: 'ignore' })`. On Linux/macOS, detached + `unref()` means the judge worker outlives the CLI process without issue. On Windows, Bun's `detached` implementation sets `UV_PROCESS_DETACHED` but there are known Bun issues with spawned processes keeping the parent alive if stdio is not fully closed. If the judge worker inherits a stdio handle from the CLI process, the CLI process may not exit cleanly on Windows.

**Why it happens:**
Bun's Windows process model is less mature than Linux. The Node.js Windows `detached: true` behavior itself has known quirks (GitHub issue 51018 in nodejs/node). `experience-core.js` uses `stdio: ['ignore', 'ignore', 'ignore']` which is correct, but if the Bun shim wraps the spawn, that `stdio` config may not be passed through cleanly.

**How to avoid:**
- Do not re-implement the judge worker spawn in the CLI shim — use `experience-core.js`'s existing spawn logic by calling its exported functions directly (e.g., `syncToQdrant()`, `recordFeedback()`) rather than re-spawning judge-worker.js
- If the spawn path is kept, explicitly test on Windows: start CLI, trigger a tool call with a matching principle, observe that the CLI exits within 500ms of the last tool call (no process-hanging)
- `muonroi-cli doctor` should check for orphaned judge-worker.js processes on Windows and offer to kill them

**Warning signs:**
- CLI hangs after all work completes on Windows (judge worker holding stdin/stdout)
- On Windows, `tasklist | findstr node` shows a node.exe process outliving the CLI after exit
- Users report `Ctrl+C` not killing the CLI on Windows when EE is active

**Phase to address:**
**v1.1 Phase 1** — verify Windows spawn behavior in the smoke test suite.

---

### Pitfall 39: Routing feedback loop (`routeFeedback`) called with wrong `taskType` corrupts EE router training data

**What goes wrong:**
The v1.1 milestone requires: "Route feedback loop wired (every turn feeds outcome to EE for continuous learning)." The `routeFeedback(request)` function in `experience-core.js` expects `{ taskType, outputStyle, modelUsed, outcome }`. If the CLI sends `taskType` from PIL Layer 1's regex-based classification (which uses 9 values: `generate`, `debug`, `refactor`, etc.) but EE's router expects the raw model-tier classification (`premium`, `balanced`, `lite`), the feedback accumulates against wrong categories. The router's learning data is polluted — it optimizes for the wrong signal.

**Why it happens:**
PIL Layer 1 and EE's `routeTask` use DIFFERENT classification ontologies. EE's router was designed around the `premium/balanced/lite` tier system. PIL was designed around task type (`generate`, `refactor`, etc.). The bridge between them is not formally specified.

**How to avoid:**
- Read `experience-core.js`'s `routeTask` and `routeFeedback` function signatures and expected payload shapes BEFORE writing the bridge code
- Map PIL `taskType` → EE router tier explicitly: `generate/refactor/debug → premium`, `analyze/documentation/plan → balanced`, `low-confidence → lite`
- The mapping must be a named function `pilTaskTypeToEETier(taskType: TaskType): 'premium' | 'balanced' | 'lite'` in `src/ee/core-shim.ts` — not inline at call sites
- Write a test: feed 10 known prompts through PIL → `routeTask` → `routeFeedback` and assert the tier distribution is plausible

**Warning signs:**
- EE router stats show 90%+ of calls as `premium` even for trivial prompts (mapping is wrong — defaulting everything to top tier)
- `routeTask` responses stop differentiating task types over time (router learned a trivially-uniform distribution)
- CLI routes most prompts to cold-path even after feedback training should have improved warm-path confidence

**Phase to address:**
**v1.1 Phase 2** — when route feedback loop is wired.

---

### Pitfall 40: `experience-core.js` uses native `fetch` (Node 20 built-in) which may conflict with Bun's global `fetch` polyfill

**What goes wrong:**
`experience-core.js` calls the global `fetch` directly (no import) — relying on Node 20's native `fetch`. In Bun's ESM/CJS hybrid context, the `fetch` that `experience-core.js` sees when loaded as a CJS module-in-ESM is Bun's own `fetch` implementation. Bun's `fetch` is generally a superset of the Web Fetch API, but there are subtle behavioral differences: Bun's `fetch` does not always respect `AbortSignal` cancellation on Windows in the same way Node does; Bun's `fetch` error shapes differ (e.g., `TypeError: Failed to fetch` vs Node's `FetchError` with `.cause`). If `experience-core.js` checks `err.cause?.code === 'ECONNREFUSED'` to detect a down Qdrant instance, this check may fail silently in Bun.

**Why it happens:**
`experience-core.js` was written for Node 20 native fetch. Bun's global fetch is a different implementation. In Node, `fetch` on a refused connection throws `TypeError { cause: { code: 'ECONNREFUSED' } }`. In Bun, the error shape is different — `err.message` may contain the code instead.

**How to avoid:**
- In the EE shim, after importing `experience-core.js`, run a connectivity test: call `searchCollection('principles', 'test', 1)` and verify the result OR the error is a known shape
- If `experience-core.js` wraps Qdrant/Ollama errors and re-throws them, read those catch paths and verify they don't rely on Node-specific error properties
- Log the raw `err` object from failed EE calls during development to identify any shape mismatches before they become silent bugs

**Warning signs:**
- EE functions silently return empty results when Qdrant is down instead of throwing (error swallowed due to shape mismatch)
- `experience-core.js` always reports Qdrant as healthy even when it's not (health check has wrong error parsing)
- Timeout behavior differs between local dev (Node) and CI (Bun) — flaky tests that pass on one runtime and fail on the other

**Phase to address:**
**v1.1 Phase 1** — verify error shapes in smoke tests for Qdrant-down and Ollama-down scenarios.

---

## Minor Pitfalls — EE-Native Integration

### Pitfall 41: Module evaluation order: `experience-core.js` may read `~/.experience/config.json` before CLI sets env vars

**What goes wrong:**
If any import in the CLI's module graph triggers evaluation of `experience-core.js` before `src/index.ts` has set `process.env.EXPERIENCE_*`, the EE module initializes with stale or default config. This is a JavaScript module evaluation order problem: dynamic `import()` controls evaluation order; static `import` at the top of a module may evaluate before user code runs.

**How to avoid:**
- Ensure `experience-core.js` is imported via dynamic `import()` AFTER env vars are set in the CLI startup sequence
- The EE shim module (`src/ee/core-shim.ts`) must be dynamically imported, not statically imported at module top-level
- Verify: add a startup log that prints `EXPERIENCE_QDRANT_URL` before and after the EE shim loads

**Warning signs:**
- EE connects to `localhost:6333` even though the CLI's config says otherwise (env was set too late)
- Changing env vars via `process.env.EXPERIENCE_QDRANT_URL = 'http://...'` after the shim module loads has no effect (mtime cache was already initialized)

**Phase to address:**
**v1.1 Phase 1** — startup sequence must be explicitly ordered.

---

### Pitfall 42: `respond_general` response tool falls back to chat for ALL non-6-type tasks, inflating token usage

**What goes wrong:**
The v1.1 target requires `respond_general` as a catch-all for tasks the 6-type classifier doesn't cover. If the classifier confidence is low and `respond_general` is chosen, and `respond_general` makes a full LLM call without checking if the task was trivial (e.g., "what year is it?"), every low-confidence classification becomes an expensive cold-path call.

**How to avoid:**
- `respond_general` must still use the router tier — it is not automatically cold-path
- For very low confidence + very short prompts, prefer a "echo and let the model decide" path rather than a dedicated tool call
- Track `respond_general` call rate; if >20% of all calls go through it, the classifier needs improvement

**Warning signs:**
- `respond_general` call rate >20% (classifier is failing, not catching edge cases)
- Token usage spikes after wiring `respond_general` — catch-all is being over-triggered

**Phase to address:**
**v1.1 Phase 2** — after classifier is improved with EE brain intent detection.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip the upstream-deps tracking file in Phase 0 | Saves 30 minutes during fork commit | Security CVE arrives in 6 months and you don't know about it | Never — Phase 0 deliverable |
| Hardcode pricing in TypeScript constants instead of remote fetch | Saves 1 day in Phase 1 | Provider pricing changes mid-month, users blame us | Acceptable in Phase 1; MUST be replaced by remote-fetch in Phase 4 |
| Single-collection Qdrant with payload filtering for v1 cloud | Easier multi-tenancy implementation | One bug in filter code = data breach | Acceptable for free tier; Pro tier should opt into dedicated shards |
| `console.log` for debugging without redactor | Faster local dev | One slip and a key leaks to a user log | Never in code paths that touch credentials; gated by build flag at most |
| Skip CI matrix for Windows in early phases | Faster Phase 1-2 iteration | Windows-specific bug ships in Phase 3 beta | Acceptable in Phase 0-2 with manual Windows smoke test; required from Phase 3 |
| Local Qdrant only, no cloud sync schema | Faster v1 ship | Phase 4 migration requires schema changes mid-flight | Acceptable IF `principle_uuid` field is set from Phase 1 |
| Naive cap-counter (no reservation ledger) | Faster Usage Guard ship | First runaway tool loop overshoots cap | Never — Phase 0 deliverable per IDEA constraint |
| Tests inherited from grok-cli left in place | Free coverage number | False confidence; real bugs ship | Never — delete during fork cleanup |
| AI SDK direct calls without adapter | Faster Phase 0 (skip adapter for hardcoded Anthropic) | AI SDK v7 migration touches 50+ files | Acceptable for Phase 0 single-provider only; Phase 1 MUST introduce adapter |
| Import `experience-core.js` as named exports without a shim | Saves one abstraction layer | Named imports are `undefined` at runtime; TypeScript masks the error | Never — shim is the only stable boundary |
| Write `~/.experience/config.json` from the CLI to bridge configs | Simple one-file approach | Overwrites user's EE config, breaks EE sidecar mid-session | Never — use env vars instead |
| Skip timeout wrapping on EE brain calls | Simplifies shim code | First Ollama cold-start blocks the orchestrator for 30s | Never — every brain call must have an explicit timeout |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Anthropic API | Pass `system` as a user message | Use the `system` parameter; messages array is user/assistant only |
| OpenAI API | Use chat completions when responses-API is now preferred | Adapter abstracts; pick per-model recommended endpoint |
| Gemini API | Assume tool-call shape matches Claude's | Each provider has different tool-call schemas; adapter normalizes |
| Ollama | Treat as identical to OpenAI-compatible endpoint everywhere | Ollama lacks some features (tool-call streaming reliability varies); test specifically |
| SiliconFlow | Assume <800ms latency p95 from China-origin endpoint | Measure from actual user regions; cold-path SLO must reflect real numbers |
| Qdrant | Use raw client SDK calls in app code | Wrap in `getCollection(tenantId)` helper; lint-ban raw calls |
| Stripe | Process webhooks without idempotency check | `INSERT ... ON CONFLICT DO NOTHING` on `processed_events` table BEFORE side effects |
| Stripe | Return 200 after a long-running side effect | Return 200 in <5s; queue heavy work async |
| Clerk/Auth0 | Assume the provider's user ID is permanent | Use a stable internal user ID; map provider IDs as aliases |
| Bun's bun:sqlite | Mix with `better-sqlite3` somewhere | Use `bun:sqlite` everywhere; never both in same process |
| OS Keychain | Assume `keytar` works on all platforms identically | macOS Keychain, Windows Credential Manager, libsecret on Linux — each has quirks; fallback to encrypted file |
| MCP client | Assume servers all behave identically | MCP servers vary in spec compliance; adapter must tolerate non-conformance |
| LSP | Forward stderr to user terminal | Capture LSP stderr separately; only show user-actionable diagnostics |
| `experience-core.js` CJS | Named ESM imports (`import { intercept }`) | Default import + destructure: `import core from '...'; const { intercept } = core` |
| `experience-core.js` config | Writing `~/.experience/config.json` from CLI | Set `EXPERIENCE_*` env vars before requiring the module |
| `experience-core.js` brain calls | No timeout wrapper on direct in-process calls | Wrap every brain call with `AbortSignal.timeout(N)` matching the calling layer's budget |
| EE + CLI Qdrant clients | Two independent `QdrantClient` instances | Route all Qdrant ops through `experience-core.js` functions; remove CLI-side client |
| PostToolUse judge | Fire feedback before posttool resolves | `await posttool(...)` THEN fire feedback — ordering is required by EE's state machine |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Hot-path classifier doing network calls | Status bar latency >100ms per call | Hard arch constraint: hot-path must be local-only | Any user with realistic prompt volume (>100/session) |
| Hook query without caching | TUI feels laggy after first 50 tool calls | Cache by `(cwd, tool, args-hash)` for 5 min | ~50 tool calls per session, instant pain |
| Qdrant payload filter without proper indexing | Multi-tenant queries slow as user count grows | Index on `tenant_id` payload field; verify with `EXPLAIN`-equivalent | ~100 tenants on shared collection |
| Streaming chunks accumulated in memory before flush | Memory grows unbounded during long responses | Flush to TUI on each chunk; backpressure-aware | Long responses (>100K tokens) on slow terminals |
| Compaction running on every turn instead of at checkpoints | Frequent latency spikes mid-conversation | Checkpoint-only triggers per QC design | Any non-trivial session |
| `.muonroi-flow/` artifact reads from disk on every state check | Filesystem load grows linearly | In-memory cache with file-watch invalidation | Long sessions with frequent state queries |
| Reservation ledger not bounded in size | Memory grows over multi-hour sessions | TTL old reservations; reconcile on disk periodically | 8+ hour sessions per IDEA success metric |
| Provider HTTP client creating new TLS connection per call | Latency floor +50-100ms on every call | Keep-alive + connection pool per provider | Realistic usage (>50 calls/session) |
| Token counter recomputing entire history on each call | Linear-time growth per turn | Incremental accumulator | Sessions >100 turns |
| EE brain call without timeout on Ollama cold-start | PIL pipeline blocks for 5-30s | `AbortSignal.timeout(200)` on PIL hot path, `AbortSignal.timeout(2000)` on router | First call after 5-min model idle — common in interactive use |
| Two Qdrant connection pools (CLI + EE) | Double connection overhead; ordering race on write-then-read | Remove CLI-side Qdrant client after EE-native restructure | Immediately post-restructure if not cleaned up |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| API keys in env vars passed to child processes | Key leaks to any process the agent spawns (e.g., a `bash` tool call) | Strip provider keys from `process.env` before any `spawn`/`exec`; pass via fd or temp file scoped to the call |
| Logs including request headers or full request body | Key + user prompt content leak to log files | Mandatory redactor; deny-list of header names + secret-shape regex |
| Crash reports with stack traces and locals | `key in scope` leaks via crash uploader | Crash reporter (if added) routes through redactor; no `process.env` capture |
| Tool call to user-supplied command without confirmation | Prompt injection: model writes `rm -rf /` and executes | Destructive commands require explicit confirm; deny-list of dangerous patterns; sandbox where feasible |
| Qdrant cloud queries without tenant filter | Cross-user principle leak | Wrapper API; lint check; pen-test before launch |
| Stripe webhook handler without signature verification | Attacker forges subscription events, gets free Pro tier | `Stripe.webhooks.constructEvent` with secret on every event |
| Ollama VPS HTTP exposed without auth | Anyone on the internet uses your warm-path brain | Bind to localhost; tunnel via SSH or Tailscale; firewall rules verified |
| Principle store readable by other users on shared filesystem | Principles often contain code/paths/PII | Mode `0700` on `~/.muonroi/`; encrypted at rest for sensitive payloads |
| MCP server allowed unrestricted file access | A malicious MCP server reads `~/.ssh/` | MCP server permissions configurable; deny by default; user opt-in |
| Token telemetry sent to our server with PII | GDPR violation | If telemetry is added, opt-in only; never include prompt content; document data flows |
| Setting `EXPERIENCE_*` env vars globally in user shell | Env var leak to other tools that also use `experience-core.js` | Set env vars on the CLI process only (`process.env.X = Y` before `import()`) — never document `export EXPERIENCE_*` in shell config |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent auto-downgrade mid-task | User thinks the agent suddenly got dumber | Surface the downgrade in status bar with explanation BEFORE switching |
| Hard cap halt with no recovery option | User loses work mid-task; rage-quits | Halt with "increase cap by $X / pause and review / kill session" — recoverable |
| `⚠️ [Experience]` warnings in non-applicable contexts | User loses trust in warnings, disables them all | Scope-tagged principles; show scope in warning |
| Status bar with too many numbers | Users ignore it (information overload) | Show only `$X.XX / $Y / Z%` and current model; details on demand |
| Hidden routing decisions | User can't predict which model will run | Show next-call-model in status bar; allow override per-call |
| Compaction warning that doesn't say what was lost | User can't trust resumed sessions | "Compacted 12 turns into summary; full history at .muonroi-flow/history/N.md" |
| Cross-platform assumptions (UNIX paths in error messages) | Windows users see `/tmp/foo` and don't know what to do | Path messages use OS-native form; error docs cross-referenced |
| Untranslated error messages from providers | "rate_limit_exceeded" with no friendly explanation | Wrap provider errors with friendly text + actionable advice |
| TUI hangs without indicator during cold-path latency | User thinks the CLI crashed | Spinner / progress indicator on every >300ms operation |
| First-run config asks for ALL keys upfront | New user friction; abandons setup | Config is incremental — start with one provider, add more as needed |

---

## "Looks Done But Isn't" Checklist

Verification gates to run before declaring a feature complete.

- [ ] **Multi-provider adapter:** Often missing — one provider's tool-call streaming actually works, others 500 silently. Verify: integration test against ALL 4 providers (Anthropic, OpenAI, Gemini, DeepSeek) + Ollama, with tool-call streaming, abort-mid-stream, and 4xx/5xx error paths.
- [ ] **Usage Guard:** Often missing — reservation ledger; only has a counter. Verify: 10 concurrent tool calls each at worst-case spend, asserting halt happens before cap, not after.
- [ ] **EE hook integration:** Often missing — scope filter; principles match cross-repo. Verify: principle created in repo A does not match queries in repo B unless explicitly scoped global.
- [ ] **QC compaction:** Often missing — decision-extraction pass; compaction loses decisions. Verify: agent can answer "what library did we choose for X" 50 turns after the decision was compacted.
- [ ] **Cross-platform builds:** Often missing — Windows native module testing. Verify: install + first-run + 10 tool calls succeed on Windows 10 + 11, macOS, Linux all in CI.
- [ ] **Key redaction:** Often missing — coverage of all log paths. Verify: `grep -r "console.log\|IMLog\|log\." src/` then audit each hit; force-trigger every error path and inspect outputs.
- [ ] **Stripe webhook:** Often missing — idempotency check before side effects. Verify: replay the same Stripe event 5 times via `stripe listen`; user state changes exactly once.
- [ ] **Migration local→cloud:** Often missing — resumability; partial-failure leaves user stuck. Verify: kill migration mid-run; restart; verify final state matches a complete run.
- [ ] **Session resume:** Often missing — abort handling; pending tool calls leave dangling state. Verify: kill CLI mid-tool-call; restart; pending tool calls are reconciled, not silently retried.
- [ ] **License attribution:** Often missing — `LICENSE-grok-cli` retained, README acknowledgment. Verify: run `licensee` scanner; manually grep for "Vibe Kit" reference.
- [ ] **Doctor command:** Often missing — pre-empts known-issue support tickets. Verify: `muonroi-cli doctor` detects: Bun version, OS, key presence, Ollama health, Qdrant health, recent error rate.
- [ ] **EE-native shim named export smoke test:** Often missing — TypeScript compiles but runtime has `undefined`. Verify: `assert(typeof intercept === 'function')` in a headless test before any call site uses the shim.
- [ ] **EE config bridge via env vars:** Often missing — config written to `~/.experience/config.json` overwrites user's EE settings. Verify: start CLI with custom Qdrant URL, confirm EE uses that URL, confirm `~/.experience/config.json` is unchanged.
- [ ] **PostToolUse → Judge ordering:** Often missing — feedback fires before posttool state resolves. Verify: instrument `posttool` and `fireFeedback` with timestamps; assert feedback always fires AFTER posttool completes.
- [ ] **Ollama cold-start timeout:** Often missing — first PIL pipeline call after 5min idle hangs. Verify: wait 6min with model loaded, trigger intent classification, assert response arrives in <200ms (timeout fires) and pipeline does not block.

---

## Recovery Strategies

When pitfalls happen despite prevention.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| API key leaked in logs | HIGH | Notify affected users immediately; rotate (their) keys via documented procedure; publish post-mortem; implement redactor if absent |
| Usage Guard cap overshot | HIGH | Refund the overshoot from operating cost (small amounts) + ship hotfix + reproduce in test; trust is harder to recover than money |
| Cross-tenant Qdrant leak | CATASTROPHIC | Immediate service halt; forensic audit of access logs; notify users per GDPR (72h); regulator notification if applicable; cannot be cleanly recovered — prevent at all costs |
| Stripe duplicate-billed user | MEDIUM | Refund via Stripe API; add idempotency-guard if absent; root-cause analysis on event ID handling |
| Local→cloud migration corrupted | HIGH | Restore from local Qdrant archive (preserved 30 days post-migration); investigate; user re-migrates after fix |
| Compaction lost critical decision | LOW-MEDIUM | User restores from `.muonroi-flow/history/` (full chat preserved); document the failure mode for next compaction improvement |
| Stale principle injected wrong warning | LOW | User marks principle unhelpful via feedback API; principle decays in confidence; next match suppressed |
| Warm-path Ollama VPS down | LOW-MEDIUM | Health-check should auto-fallback to cold-path; if not, manual config flag; investigate VPS root cause separately |
| EE shim named imports are `undefined` | LOW | Add default-import + destructure; re-run smoke test; no data loss |
| EE config bridge overwrites user's EE settings | MEDIUM | Restore `~/.experience/config.json` from user backup; switch bridge to env-var approach; document the incident |
| Feedback fires before posttool state resolves | LOW | Add `await posttool(...)` before `fireFeedback()`; re-run e2e test; existing corrupted feedback entries self-correct over time via hit accumulation |
| Ollama cold-start blocks orchestrator | LOW | Add `AbortSignal.timeout(200)` to brain call; add Ollama warm-up on CLI startup; no data loss |
| AI SDK breaking change post-pin | MEDIUM-HIGH | Migration guide + codemod; phased rollout (canary → all users); patch release |
| Solo-maintainer support overload | MEDIUM | Pause new beta enrollment; triage queue with templates; consider hiring or community moderation |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| # | Pitfall | Severity | Prevention Phase | Verification |
|---|---------|----------|------------------|--------------|
| 1 | Untracked upstream | HIGH | Phase 0 | `UPSTREAM_DEPS.md` exists; CI dependency check passes |
| 2 | API key leaks | HIGH | Phase 0 | Key redactor unit-tested; keychain integration smoke-tested per OS |
| 3 | Usage Guard race | HIGH | Phase 0 | 10-concurrent-call test asserts halt before cap |
| 4 | Qdrant tenant leak | HIGH | Phase 1 (schema) + Phase 4 (impl) | Pen-test cross-user query returns 404 |
| 5 | Stripe duplicate processing | HIGH | Phase 4 | Replay-event test asserts single side-effect |
| 6 | Stale principle wrong context | HIGH | Phase 1 | Cross-repo match test asserts scope filter |
| 7 | Local→cloud migration loss | HIGH | Phase 1 (schema) + Phase 4 (impl) | Mid-run-kill test asserts resumability |
| 8 | Warm-path single point of failure | HIGH | Phase 1 | VPS-down simulation auto-fallbacks to cold |
| 9 | Streaming abort dangling state | HIGH | Phase 0 | Ctrl+C-mid-call test asserts no `.tmp` files orphaned |
| 10 | Token counter drift | MEDIUM | Phase 0 | End-of-session reconciliation report |
| 11 | Hot-path overfits | MEDIUM | Phase 1 | Confidence-threshold escalation tested |
| 12 | Auto-downgrade UX | MEDIUM | Phase 0 | Threshold UX manual review with beta tester |
| 13 | Compaction drops content | MEDIUM | Phase 2 | "What library did we choose" test 50 turns later |
| 14 | Artifact path conflict | MEDIUM | Phase 2 | Naming decided in DECISIONS.md before implementation |
| 15 | License attribution drift | MEDIUM | Phase 0 | CI check on `LICENSES/grok-cli.txt` immutability |
| 16 | Bun on Windows ABI | MEDIUM | Phase 0 (validate) + Phase 3 (CI matrix) | Windows install test in CI |
| 17 | Ollama Windows GPU | MEDIUM | Phase 1 | GPU-detection banner shown when on CPU |
| 18 | Inherited tests irrelevant | MEDIUM | Phase 0 | Coverage report after cleanup is honest baseline |
| 19 | Currency/pricing change | MEDIUM | Phase 1 (abstraction) + Phase 4 (remote fetch) | Pricing-table replacement is O(1) |
| 20 | Solo support overload | MEDIUM | Phase 3 | Issue templates + `doctor` command shipped |
| 21 | Key revocation cached | LOW | Phase 1 | 401-handling test asserts re-auth prompt |
| 22 | Rate-limit surfaced as error | LOW | Phase 1 | 429 response triggers backoff + user-friendly message |
| 23 | Plan upgrade config drift | LOW | Phase 4 | `config validate` passes after tier change |
| 24 | Routing decision expensive | LOW | Phase 1 | Hot-path latency p99 < 5ms in CI |
| 25 | Hook latency bleed | LOW | Phase 1 | Hook p99 < 50ms |
| 26 | AI SDK v7 incompatibility | LOW | Phase 1 (adapter) | Adapter unit tests don't import AI SDK directly |
| 27 | Competitor catches up | STRATEGIC | Always | Public roadmap; focus on multi-provider + BYOK moat |
| 28 | Provider API deprecation | LOW | Phase 1 (adapter) | Adapter has version-pinned endpoint mapping per provider |
| 29 | OSS competitor on principles | STRATEGIC | Always | Pro tier value > just persistent memory |
| 30 | Junk principles pollute | LOW | Phase 1 (schema) + Phase 2 (pruning) | Confidence schema present; periodic prune job |
| 31 | CJS named export undefined at runtime | HIGH | v1.1 Phase 1 | `typeof intercept === 'function'` smoke test passes |
| 32 | EE + CLI config diverge silently | HIGH | v1.1 Phase 1 | CLI with custom Qdrant URL — EE uses same URL; `~/.experience/config.json` unchanged |
| 33 | Dual Qdrant connection pools | MEDIUM | v1.1 Phase 2 | No duplicate `QdrantClient` instances after PIL Layer 3 migration |
| 34 | EE sidecar breaks from CLI config writes | HIGH | v1.1 Phase 1 | EE sidecar session uninterrupted after CLI startup |
| 35 | Ollama cold-start blocks hot path | HIGH | v1.1 Phase 1 | PIL pipeline completes in <200ms even after 6-min model idle |
| 36 | Auto-judge deadlock / ordering race | MEDIUM | v1.1 Phase 2 | Feedback timestamps always after posttool timestamps in activity log |
| 37 | `__dirname` mismatch in CJS-in-ESM | MEDIUM | v1.1 Phase 1 | Judge-worker spawn resolves to existing file on Windows |
| 38 | Detached spawn not fully detached on Windows | MEDIUM | v1.1 Phase 1 | CLI exits within 500ms on Windows after last tool call |
| 39 | Wrong `taskType` in routing feedback | MEDIUM | v1.1 Phase 2 | Router tier distribution is plausible across 10 test prompts |
| 40 | Bun fetch error shape differs from Node | MEDIUM | v1.1 Phase 1 | Qdrant-down and Ollama-down error paths produce correct logs in Bun |
| 41 | Module evaluation order fires EE before env vars set | LOW | v1.1 Phase 1 | Dynamic `import()` of shim is after env var setup in startup sequence |
| 42 | `respond_general` over-triggered | LOW | v1.1 Phase 2 | `respond_general` call rate <20% in test suite across 50 prompts |

---

## Sources

**Direct domain knowledge (HIGH confidence):**
- `D:/Personal/Core/muonroi-cli/.planning/PROJECT.md` — requirement set, success metrics, milestone v1.1 goal
- `D:/Personal/Core/muonroi-cli/src/ee/` — existing HTTP client, judge, posttool, intercept, types
- `D:/Personal/Core/muonroi-cli/src/pil/` — pipeline, layer1-intent, layer3-ee-injection, layer6-output
- `D:/Personal/Core/muonroi-cli/src/storage/config.ts` — `~/.muonroi-cli/config.json` ownership
- `D:/Personal/Core/experience-engine/.experience/experience-core.js` — CJS exports, config loading, Qdrant calls, judge-worker spawn
- `D:/Personal/Core/experience-engine/.experience/interceptor-post.js` — PostToolUse hook, file-based state, judge-worker detached spawn
- `D:/Personal/Core/experience-engine/server.js` — EE sidecar endpoints, config loading at startup
- `D:/Personal/Core/experience-engine/package.json` — `"type": "commonjs"`, zero npm dependencies

**Verified via WebSearch (MEDIUM confidence, multiple sources agree):**
- [Bun module resolution docs](https://bun.com/docs/runtime/module-resolution) — `require()` in ESM context, CJS/ESM interop semantics
- [Bun CommonJS not going away post](https://bun.sh/blog/commonjs-is-not-going-away) — `__esModule` flag behavior, default vs named import interop
- [Bun CJS named exports issue #12463](https://github.com/oven-sh/bun/issues/12463) — CJS named exports in ESM are broken in certain edge cases
- [ag2 DefaultPattern deadlock issue #2144](https://github.com/ag2ai/ag2/issues/2144) — async tool execution deadlock pattern analogous to auto-judge ordering
- [Bun node:child_process spawn docs](https://bun.com/reference/node/child_process/spawn) — detached option behavior
- [Windows spawn detached bug nodejs/node #51018](https://github.com/nodejs/node/issues/51018) — `detached: true` + stdio on Windows
- [Ollama timeout fix guide](https://www.aimadetools.com/blog/ollama-api-timeout-fix/) — cold-start latency 5-30s; `AbortSignal.timeout` pattern
- [Qdrant singleton pattern issue #372](https://github.com/qdrant/qdrant-client/issues/372) — singleton vs multiple client instances
- [ESM vs CJS 2026 guide](https://sandeepbansod.medium.com/esm-vs-cjs-why-your-import-still-breaks-in-2026-and-how-to-finally-fix-it-9a16c318a291) — runtime error patterns for CJS-in-ESM import mismatches

---

*Pitfalls research for: muonroi-cli — base project + v1.1 EE-Native CLI milestone*
*Originally researched: 2026-04-29 | Milestone addendum: 2026-05-01*
