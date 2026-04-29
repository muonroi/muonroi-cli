# Pitfalls Research

**Domain:** BYOK AI coding agent CLI built by forking and amputating `grok-cli`, integrated with Experience Engine (Qdrant + EE server) and Quick Codex run-artifact system, distributed cross-platform with eventual SaaS billing layer.
**Researched:** 2026-04-29
**Confidence:** HIGH for fork/BYOK/router/EE/QC dimensions (direct domain knowledge + verified sources). MEDIUM for Phase-4 SaaS pitfalls (forward-looking, less direct evidence). MEDIUM for cross-platform pitfalls (verified through GitHub issue threads on Bun/Ollama).

This document catalogs failure modes specific to muonroi-cli's design — fork-and-amputate baseline, BYOK pricing, 3-tier brain router, Usage Guard, EE/QC integration, multi-platform shipping, and Phase-4 SaaS prep. Each entry is severity-ranked and phase-mapped so the roadmapper can prioritize prevention.

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
**Phase 0** — fork validates Bun on Windows during initial cleanup. **Phase 3** — release polish includes the cross-platform CI matrix.

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
**Phase 0** — delete obsolete tests during fork cleanup. **Phase 3** — comprehensive test review during beta polish.

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
**Phase 1** — pricing-table abstraction is part of multi-provider adapter. Remote-fetch is a Phase 4 enhancement.

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
- Public roadmap of known issues so users see "this is acknowledged"
- Cap beta enrollment by gradient — 10 users week 1, 30 week 2, 100 by month 1; pause if response time blows out
- Status page (even a simple `STATUS.md`) for outages

**Warning signs:**
- Inbox of duplicates within hours of a release
- Same question asked 5 times — needs to be in FAQ or doctor
- Maintainer burnout signals (response time growing, quality dropping)

**Phase to address:**
**Phase 3** — beta-prep is Phase 3. Issue templates and `doctor` command must ship with beta launch.

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

**Phase:** Phase 1 (when EE PreToolUse hook is wired) for the confidence schema; Phase 2 for pruning logic.

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
| User clipboard auto-copied with key prefix | Clipboard sniffer (other apps) reads it | Never auto-copy keys; explicit confirm only |

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
| Beta-tester reports in Vietnamese / non-English ignored | Solo maintainer is Vietnamese, but issues come in English-only template | Template accepts both; auto-translate where helpful |
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
- [ ] **Routing decision telemetry:** Often missing — visibility into WHY a call was routed where. Verify: every call has a structured log entry with `tier=hot|warm|cold`, `reason=...`, `confidence=...`.
- [ ] **Session resume:** Often missing — abort handling; pending tool calls leave dangling state. Verify: kill CLI mid-tool-call; restart; pending tool calls are reconciled, not silently retried.
- [ ] **License attribution:** Often missing — `LICENSE-grok-cli` retained, README acknowledgment. Verify: run `licensee` scanner; manually grep for "Vibe Kit" reference.
- [ ] **Error envelope:** Often missing — provider 429/401/500 surfaced with actionable advice. Verify: trigger each error class via mocking; user sees explanation + next step, not opaque dump.
- [ ] **Doctor command:** Often missing — pre-empts known-issue support tickets. Verify: `muonroi-cli doctor` detects: Bun version, OS, key presence, Ollama health, Qdrant health, recent error rate.

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
| Auto-downgrade caused user-visible regression | MEDIUM | Surface a "switch back to Opus" button at 100% threshold breach; refund operating cost for that user as goodwill |
| Streaming abort left half-written file | LOW | `.tmp` files identifiable by suffix; doctor command cleans them; user prompted on next run |
| AI SDK breaking change post-pin | MEDIUM-HIGH | Migration guide + codemod; phased rollout (canary → all users); patch release |
| License attribution found missing | MEDIUM | Restore `LICENSE-grok-cli`; public acknowledgment; CI check added |
| Solo-maintainer support overload | MEDIUM | Pause new beta enrollment; triage queue with templates; consider hiring or community moderation |
| Provider deprecated API mid-flight | MEDIUM | Adapter swap to new endpoint; release patch; deprecation runway gives 6 months usually |
| Cursor/Claude Code shipped same feature | STRATEGIC | Lean into BYOK + multi-provider + offline-first differentiation; ship faster on remaining differentiators |

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

---

## Sources

**Direct domain knowledge (HIGH confidence):**
- `D:/sources/Core/muonroi-cli/IDEA.md` — locked architectural decisions, hard constraints
- `D:/sources/Core/muonroi-cli/.planning/PROJECT.md` — requirement set, success metrics
- User memory `MEMORY.md` — Experience Engine v3.2 state, IMLog rule, multi-repo workspace, library-first principles
- CLAUDE.md global directives — hooks, feedback API, behavioral rules

**Verified via WebSearch (MEDIUM confidence, multiple sources agree):**
- [Bun SQLite — Bun docs](https://bun.com/docs/runtime/sqlite) — `bun:sqlite` is preferred over `better-sqlite3` for ABI compatibility
- [Bun better-sqlite3 ABI mismatch — GitHub Issue #319](https://github.com/tobi/qmd/issues/319) — NODE_MODULE_VERSION 141 mismatch on Windows
- [Bun better-sqlite3 crash — GitHub Issue #24956](https://github.com/oven-sh/bun/issues/24956) — Windows-specific failure mode
- [Bun Windows path support — GitHub Issue #22002](https://github.com/oven-sh/bun/issues/22002) — Windows Server quirks
- [AI SDK 6 migration guide — Vercel](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0) — `ToolCallOptions` rename, async `convertToModelMessages`
- [AI SDK 6 announcement — Vercel](https://vercel.com/blog/ai-sdk-6) — release shape and breaking changes
- [AI SDK v7 issue tracker — GitHub Issue #14011](https://github.com/vercel/ai/issues/14011) — forthcoming changes
- [OpenAI API key safety best practices](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety) — env var leak risks
- [Smallstep CLI secrets handling guide](https://smallstep.com/blog/command-line-secrets/) — env var/shell-history leak vectors
- [Stripe webhooks — duplicate handling](https://www.duncanmackenzie.net/blog/handling-duplicate-stripe-events/) — at-least-once delivery semantics
- [Stripe webhook idempotency guide — Hookdeck](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency) — `processed_events` table pattern
- [Why Stripe webhooks silently fail — DEV.to](https://dev.to/jordan_sterchele/why-your-stripe-webhooks-are-silently-failing-and-how-to-fix-all-of-it-aio) — timeout retries
- [Qdrant multi-tenancy docs](https://qdrant.tech/documentation/manage-data/multitenancy/) — payload-based partitioning pattern
- [Qdrant tiered multi-tenancy — 1.16 release](https://qdrant.tech/blog/qdrant-1.16.x/) — dedicated shards for large tenants, hard isolation
- [Qdrant data residency — multitenancy article](https://qdrant.tech/articles/multitenancy/) — region-based custom sharding
- [Ollama Windows GPU detection — GitHub Issue #13338](https://github.com/ollama/ollama/issues/13338) — RTX 5090 detection failures
- [Ollama Windows CPU fallback — GitHub Issue #12618](https://github.com/ollama/ollama/issues/12618) — silent fallback to CPU
- [Ollama hardware support docs](https://docs.ollama.com/gpu) — driver-install ordering matters

**Strategic/forward-looking (MEDIUM-LOW confidence — judgment-based):**
- Pitfalls 27, 29 (competitive landscape) — informed by IDEA's "Why not Cursor" framing; cannot be empirically verified

---

*Pitfalls research for: muonroi-cli (BYOK AI coding agent CLI, fork-and-amputate of grok-cli, EE+QC integration, Phase-4 SaaS prep)*
*Researched: 2026-04-29*
