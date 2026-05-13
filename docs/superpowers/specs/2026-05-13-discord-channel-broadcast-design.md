# Subsystem F — Discord Channel-per-Product Design Spec (v2)

**Date:** 2026-05-13
**Author:** muonroi
**Status:** Approved (sections 1–4) + revised after 4-agent cross-review (49 findings)
**Builds on:** Subsystem E (phase orchestrator, commits 27fb4a2 → 8408db0)
**Forward-compat for:** Subsystem G (env initialization — VM/container provisioning).

**Cross-review applied:** Critical and Important architectural / cost / pattern findings have been integrated; test-gap findings drive the testing matrix in §4 and will land as explicit tasks in the plan stage.

---

## 1. Goal & Scope

### Goal

Make a Discord channel the primary customer/stakeholder touchpoint during a product run. The bot (1) lazily creates a private channel per product, (2) broadcasts every `push_notification` chunk (sprint review, retro, standup) into the channel, and (3) conducts a free-form conversational verdict-capture loop with the customer in the channel — replacing the terminal `awaitCustomerVerdict` from E when Discord is configured. The CLI gains a `muonroi share` command to grant channel access to a Discord user.

### In-scope

1. Channel-per-product, find-or-create keyed on `productSlug = sha1(idea).slice(0,8) + "-" + slugify(idea).slice(0,40)` with Discord-compatible normalization.
2. Lazy create — trigger on first `push_notification` chunk for a product.
3. Private channel; bot grants view + post permission via `muonroi share <user-id-or-@mention>`.
4. Broadcast: every `StreamChunk { type: "push_notification" }` posted to the channel when Discord is configured. Chunk also yields to terminal (additive).
5. Conversational verdict: `awaitCustomerVerdict` replaced by a Discord polling loop that classifies customer messages into `accept | reject | abort | discuss` via leader LLM and posts a reply each turn, with bounded retries / per-sprint message caps.
6. CLI: `muonroi share <user> [--product <slug>]` to add a stakeholder.
7. Opt-in via `MUONROI_DISCORD_TOKEN` + `MUONROI_DISCORD_GUILD_ID` env. Absent → E behavior unchanged (terminal-only).

### Out-of-scope (defer)

- Gateway WS / real-time event subscriptions (REST polling only).
- Slash commands inside Discord (`/accept`, etc.).
- Auto-archive channel after N days idle.
- Secret/PII scrubbing (user owns what they share).
- Multi-tenant bot (one bot serving many users).
- Schema migrators for the new JSON stores beyond v1 (stores are versioned and back up on corrupt; migrators added when v2 is introduced).

### Forward-compat for Subsystem G

G is the next subsystem: it provisions an isolated environment (VM, container, workspace dir) per product when the run starts. F is designed so G plugs in without breaking changes. Key extension points:

- `productSlug()` is a shared utility — G reuses the same slug for env naming.
- `stakeholder-acl.ts` is product-scoped and Discord-agnostic — G reads the same list to set SSH / workspace ACLs.
- `broadcast-bus.publish(slug, type, content)` accepts an explicit `BroadcastType` union including `env-provisioning | env-ready | env-teardown` reserved for G.
- `ensureChannel(slug, displayName, { eager?: boolean })` accepts an `eager: true` override — G can pre-create the channel at run start.
- F exposes `registerChannelCreatedHook(fn)` + `clearChannelCreatedHooks()` (test-isolation safe) — G subscribes to post an intro message when env comes online.

---

## 2. Architecture (8 layers)

### Layer A — Discord REST client

**File:** `src/discord/client.ts`

Thin wrapper around `fetch` for Discord REST v10. Reuses `withRateLimitBackoff` extracted into a shared util as part of this work (see §6.A0).

```ts
export interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}
export interface DiscordClient {
  createChannel(guildId: string, name: string, opts: { topic?: string; isPrivate?: boolean }): Promise<{ id: string }>;
  getChannelMessages(channelId: string, opts: { afterId?: string; limit?: number }): Promise<DiscordMessage[]>;
  postMessage(channelId: string, content: string): Promise<{ id: string }>;
  addChannelPermission(channelId: string, userId: string, allow: number, deny: number): Promise<void>;
  getCurrentUserId(): Promise<string>;
  listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>>;
}
```

Concrete implementation: `new DiscordRestClient(token, fetch)`. Tests inject a `MockDiscordClient`. `withRateLimitBackoff` honors Discord's `Retry-After` header.

### Layer B — Product identity (shared with G)

**File:** `src/product-loop/product-identity.ts` (new)

```ts
export function productSlug(idea: string): string;
// Implementation contract:
//   1. h = sha1(idea).slice(0, 8)
//   2. s = slugify(idea):
//        - lowercase
//        - normalize NFKD, strip combining marks
//        - replace any char NOT matching /[a-z0-9]/ with "-"
//        - collapse consecutive "-" into one
//        - trim leading/trailing "-"
//        - slice(0, 40)
//   3. return `${h}-${s}` (8 + 1 + ≤40 = ≤49 chars)
// Channel name = `muonroi-${slug}` → ≤57 chars, well within Discord's 100-char limit.
// Round-trip invariant: Discord's own name transform produces the same string back.
```

Slugify implementation lives at `src/utils/slugify.ts` (extracted from the existing private `slugifyTitle` in `ship-polish.ts`; pattern review identified it should be shared).

### Layer C — Stakeholder ACL (shared with G)

**File:** `src/product-loop/stakeholder-acl.ts` (new)

Persists at `${muonroiHome()}/stakeholders.json` where `muonroiHome()` resolves to `${MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli")}` (existing convention from `src/cli/usage-report.ts:31`).

```ts
export interface Stakeholder {
  discordUserId: string;
  displayName: string;
  addedAtUtc: string;
  addedBy: "owner" | "cli";
}
export interface StakeholderStore {
  version: 1;
  items: Record<string /* productSlug */, { productSlug: string; stakeholders: Stakeholder[] }>;
}
export async function listStakeholders(slug: string): Promise<Stakeholder[]>;
export async function addStakeholder(slug: string, s: Stakeholder): Promise<void>;
export async function removeStakeholder(slug: string, discordUserId: string): Promise<void>;
```

Idempotent: re-adding the same `discordUserId` is a no-op (logged once).
All writes go through `withFileLock(filePath, fn)` (new helper, §6.A1) to serialize concurrent processes.

### Layer D — Channel manager

**File:** `src/discord/channel-manager.ts` (new)

```ts
export interface DiscordChannelMapping {
  productSlug: string;
  channelId: string;
  guildId: string;
  createdAtUtc: string;
  displayName: string;
}
export async function ensureChannel(args: {
  client: DiscordClient;
  guildId: string;
  slug: string;
  displayName: string;
  eager?: boolean;  // reserved for G; default false (lazy)
}): Promise<{ channelId: string; created: boolean } | null>;
// Returns null when Discord is disabled, permission is denied, or token is invalid.

export function registerChannelCreatedHook(fn: (slug: string, channelId: string) => Promise<void>): void;
export function clearChannelCreatedHooks(): void;
// Hook list lives behind getter/clearer to allow test isolation.
```

**Algorithm:**
1. **In-process dedup:** every `ensureChannel(slug)` call returns the same in-flight Promise when called concurrently with the same slug. Implemented via `Map<slug, Promise<...>>` in module scope. Test concern: see test-gap-2 (concurrent first-broadcast race).
2. **Cache hit:** read `${muonroiHome()}/discord-channels.json`; if slug present, verify via `listGuildChannels` matches by id; if alive, return `{ channelId, created: false }`.
3. **Cache miss, name found:** search guild channels for `muonroi-${slug}` (exact match — Discord lowercases on create, so this is deterministic when slug is already lowercase, see Layer B). If found, persist mapping, return.
4. **Cache miss, name missing:** call `createChannel` with type GUILD_TEXT, isPrivate=true, topic `${displayName} — managed by muonroi-cli`.
5. **Sync permissions:** read stakeholder-acl for slug; call `addChannelPermission` for each.
6. **Persist mapping** (atomic write + lock). Invoke `onChannelCreated` hooks. Return `{ channelId, created: true }`.

Failures:
- 401 (invalid token) → log once, return null.
- 403 (bot not in guild, missing permission) → log once, return null.
- 429 → `withRateLimitBackoff`.
- 404 on cache verification → invalidate cache entry, retry create.

### Layer E — Broadcast bus

**File:** `src/discord/broadcast-bus.ts` (new)

```ts
export type BroadcastType =
  | "phase-event"      // F: push_notification chunk passthrough
  | "env-provisioning" // G: env starting
  | "env-ready"        // G: env online
  | "env-teardown"     // G: env shutting down
  | "custom";          // open-ended escape hatch
export async function publish(args: {
  client: DiscordClient;
  channelId: string;
  type: BroadcastType;
  content: string;
}): Promise<{ messageId: string } | null>;
```

**Content handling:**
- Empty content → return `null` (no API call); emit one-line StreamChunk warning.
- Content > 1900 chars (Discord limit is 2000; reserve 100 for prefix/marker) → split into chunks at the nearest paragraph or newline boundary; post sequentially; return the last `messageId`. Each split message except the last has trailing `… (continued)`; each except the first has leading `(continued) …`.
- 429 → `withRateLimitBackoff`.
- 404 / 403 → return null + warning. Caller invalidates channel cache.

### Layer F — Verdict resolver

**File:** `src/discord/verdict-resolver.ts` (new)

```ts
export async function discordAwaitVerdict(args: {
  flowDir: string;
  runId: string;
  phaseId: string;
  sprintN: number;
  productSlug: string;
  channelId: string;
  client: DiscordClient;
  leader: LeaderLike;
  capUsd: number;
  remainingUsd: () => Promise<number>;
  reviewSummary: string;
  backoffDelays?: number[];
  pollIntervalMs?: number;  // default 5000
  timeoutMs?: number;       // default 24h
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fallback: () => Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
}): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
```

**Constants (§4.Constants):**
- `VERDICT_FLOOR = max(0.10, 0.01 * capUsd)` (replaces handoff floor reuse — verdict is repeated per message, semantics match `review` floor).
- `MAX_VERDICT_MESSAGES_PER_SPRINT = max(20, Math.floor(0.02 * capUsd / 0.012))` — caps cost per sprint at ~`0.02 * capUsd` (≈$0.21 for cap=$10, 20 msgs).
- `MAX_LEADER_FAILURES_BEFORE_FALLBACK = 3` (consecutive `leader.generate` errors, network/5xx).
- `MAX_UNKNOWN_INTENT_BEFORE_FALLBACK = 5` (intents not in `{accept, reject, abort, discuss}`).
- `MAX_MESSAGES_PER_POLL = 50` (Discord limit). Loop natively paginates across polls via `lastSeenId`.

**Loop pseudocode (see §3.Flow 2 for full data flow):**
```
on entry:
  ensureChannel(slug)  // cache hit on hot path
  postedId = publish(...)
  lastSeenId = restore PollCursor or postedId
  startedAt = now()
  msgCount = 0
  leaderFailures = 0
  unknownIntents = 0

loop:
  if now() - startedAt > timeoutMs:
    return {verdict: "abort", feedback: "[timeout-24h]"}
  if remainingUsd() < VERDICT_FLOOR:
    publish budget-exhausted message
    return {verdict: "abort", feedback: "budget-exhausted"}
  if msgCount >= MAX_VERDICT_MESSAGES_PER_SPRINT:
    publish "Reached per-sprint message cap; deferring to terminal" message
    return await args.fallback()

  try:
    msgs = client.getChannelMessages(channelId, {afterId: lastSeenId, limit: MAX_MESSAGES_PER_POLL})
  catch e:
    if e.status in {403, 404}: return await args.fallback()
    if e.status === 429: handled by withRateLimitBackoff
    else: leaderFailures++; if exceed → return await args.fallback(); else sleep + continue

  msgs = msgs.filter(m => m.author.id !== botUserId)
  if msgs.length === 0: sleep(pollIntervalMs); continue

  for msg in msgs:
    msgCount++
    try:
      raw = await leader.generate({system: SYSTEM_PROMPT, prompt: buildConvoPrompt(reviewSummary, priorN=5, msg), maxTokens: 400})
      leaderFailures = 0
    catch:
      leaderFailures++
      if leaderFailures >= MAX_LEADER_FAILURES_BEFORE_FALLBACK: return await args.fallback()
      sleep(backoffDelays[leaderFailures-1]); continue inner-for

    parsed = parseConvoReply(raw.content)
    if parsed.intent NOT in {accept, reject, abort, discuss}:
      unknownIntents++
      if unknownIntents >= MAX_UNKNOWN_INTENT_BEFORE_FALLBACK: return await args.fallback()
      parsed.intent = "discuss"  // permissive fallback for this message

    await publish(channelId, "phase-event", parsed.reply)
    // advance cursor AFTER successful reply — survives mid-leader crash
    lastSeenId = msg.id
    persistPollCursor(phaseId, sprintN, lastSeenId)

    if parsed.intent in {accept, reject, abort}:
      return {verdict: parsed.intent, feedback: parsed.intent === "accept" ? undefined : msg.content}
```

Cursor-advance rule: cursor moves **after** successful publish of bot reply. On crash mid-leader-call, the message is re-processed on resume (idempotent leader call expected to produce same intent). This is the correct safety boundary.

### Layer G — Stakeholder CLI

**File:** `src/cli/share-cmd.ts` (new)

```
muonroi share <user-id-or-@mention> [--product <slug>] [--display <name>]
```

Resolves product:
- `--product` flag wins.
- Else read most recent run's `manifest.json` from `${cwd}/.flow/runs/`.
- Else error: "no active product found; pass --product".

User ID parsing:
- Raw 17–20-digit snowflake → use as-is.
- `<@user_id>` or `<@!user_id>` Discord mention → extract digits.
- `@something` without digits → error: "expected Discord user ID or `<@…>` mention".

Behavior:
1. Validate user ID format.
2. `addStakeholder(slug, …)`. Idempotent: if already present, print `User <name> is already a stakeholder` and exit 0.
3. Read channel mapping; if missing → print `Channel will be granted access on creation.` and exit 0.
4. `client.addChannelPermission(...)`. On 50007 (Cannot send messages to this user) / 50013 (Missing permissions) → print actionable error + note ACL is still persisted; exit 0.
5. Post `@${displayName} đã được thêm vào product` (broadcast bus).
6. Append audit line via `appendSystemMessage` to the active run's `messages.md` (matches E pattern).

CLI registration: F adds the subcommand to whatever the actual CLI entry-point is (verified during plan stage — pattern review noted `src/cli/index.ts` does not exist; entry-point is likely `package.json bin` → `src/cli.ts` or similar). The plan's first task confirms and wires accordingly.

### Layer H — Wiring & gating

**File:** `src/product-loop/index.ts` (modify in `runStart` / `runResume`)

When both `MUONROI_DISCORD_TOKEN` and `MUONROI_DISCORD_GUILD_ID` are set:
1. Build `DiscordRestClient` once.
2. Wrap the **`phaseGen` yield loop** (NOT the `sprintRunner` adapter — arch C1):
   ```
   for await (const chunk of phaseGen) {
     if (chunk.type === "push_notification") {
       const slug = productSlug(manifest.idea);
       const ch = await ensureChannel({client, guildId, slug, displayName: manifest.idea});
       if (ch) await publish({client, channelId: ch.channelId, type: "phase-event", content: chunk.content});
     }
     yield chunk;  // continue to terminal
   }
   ```
3. Replace `awaitCustomerVerdict` in the `runPhases` call with `discordAwaitVerdict(...)`, passing the existing terminal `respondToQuestion`-based path as `fallback`.

Partial env config (exactly one of token / guild set): emit one-time warning `"MUONROI_DISCORD_TOKEN/_GUILD_ID partially configured; Discord disabled"` to stderr, skip Discord wiring.

Both env vars absent → no Discord code path executes; E behavior preserved.

---

## 3. Data flow

### Flow 1 — Broadcast

```
phase-runner yields { type: "push_notification", content }
  ↓
index.ts phaseGen-yield wrapper (NOT sprintRunner wrapper):
  slug = productSlug(manifest.idea)
  result = await ensureChannel({...})   // dedup'd in-process per slug
  if result: await publish({client, channelId: result.channelId, type: "phase-event", content})
  ↓
yield the chunk onward to terminal (additive)
```

### Flow 2 — Conversational verdict

See pseudocode in §2.Layer F. Key invariants:

1. **Cursor advance is post-reply.** Bot reply published successfully → then cursor moves. Crash before publish → message re-processed on resume.
2. **Per-sprint message cap** caps total leader spend per sprint to ~`0.02 × capUsd`.
3. **Three retry budgets:** (a) `withRateLimitBackoff` for transient network/429; (b) `MAX_LEADER_FAILURES_BEFORE_FALLBACK=3` for `leader.generate` exceptions; (c) `MAX_UNKNOWN_INTENT_BEFORE_FALLBACK=5` for malformed/unknown intents.
4. **Fallback path** is the terminal `respondToQuestion` from E, injected as `args.fallback`. Used on 403/404/leader-exhausted/unknown-intent-exhausted/per-sprint-cap. NEVER on pure timeout (timeout → abort feedback `[timeout-24h]`).
5. **Pagination:** if Discord returns 50 messages, the next loop iteration polls with the new `lastSeenId` and picks up message 51+.

### Flow 3 — Stakeholder add (CLI)

See Layer G algorithm.

### Intent classification prompt

```
System: "You are the PO leading product '${productName}'. Read the customer's recent messages in this Discord channel. Reply in the SAME language the customer used (default Vietnamese). Output strict JSON ONLY (no code fences, no commentary outside JSON):

{
  \"intent\": \"accept\" | \"reject\" | \"abort\" | \"discuss\",
  \"reply\": string (≤500 chars)
}

intent semantics:
  - accept: customer is explicitly satisfied with this sprint and wants to move on.
  - reject: customer wants specific changes but wants to continue the product (will iterate next sprint).
  - abort: customer wants to STOP the entire product (cut losses, wrong direction, no longer needed).
  - discuss: customer asks a question, shares info, is exploring, OR is undecided. NO verdict yet.

RULES:
  - Be CONSERVATIVE. When in doubt, choose 'discuss'.
  - Negations matter: \"I don't accept this\" is NOT 'accept'. Read the full intent.
  - Emoji-only messages (e.g. '👍') without context: classify 'discuss' and ask for clarification.
  - Keyword matching is FORBIDDEN. Use full-message semantics."

Prompt:
  Sprint review summary:
    <reviewSummary, truncated to 1500 chars>

  Prior conversation (last 5 turns; chronological):
    customer: <m1>
    bot: <r1>
    ...

  New customer message:
    <msg>
```

### Cost guard

Per leader call (one per customer message) gated by `remainingUsd() > VERDICT_FLOOR` AND `msgCount < MAX_VERDICT_MESSAGES_PER_SPRINT`. Below either → post deterministic msg and return abort (budget) or fallback (msg cap).

---

## 4. Schemas, persistence, error handling, testing

### Persisted artifacts

| File | Scope | Path | Shape |
|---|---|---|---|
| Stakeholders | global, cross-run | `${muonroiHome()}/stakeholders.json` | `StakeholderStore` |
| Channel map | global, cross-run | `${muonroiHome()}/discord-channels.json` | `{ version:1, items: Record<slug, DiscordChannelMapping> }` |
| Poll cursor | per-run | `state.md` section `Discord Poll Cursor` | `{ version:1, cursors: PollCursor[] }` |

All writes:
- Use `atomicWriteText` (existing) for JSON files.
- Wrapped in `withFileLock(filePath, fn)` (new helper) to serialize cross-process writes.
- Section-map I/O for `state.md` follows the same pattern as E (`readArtifact`/`writeArtifact`).
- Corrupt-JSON recovery: detect via `JSON.parse` failure; back up to `${file}.corrupt-${timestamp}`; reinitialize fresh store; log warning.
- Wrong-schema-version recovery: if `version > 1`, refuse to operate; log error advising downgrade; do NOT silently treat as v1.

### Constants reference

```ts
// src/discord/verdict-constants.ts
export const VERDICT_FLOOR_MIN_USD = 0.10;
export const VERDICT_FLOOR_FRACTION = 0.01;
export const MAX_VERDICT_MESSAGES_BASE = 20;
export const MAX_VERDICT_FRACTION = 0.02;  // 2% of capUsd
export const MAX_LEADER_FAILURES_BEFORE_FALLBACK = 3;
export const MAX_UNKNOWN_INTENT_BEFORE_FALLBACK = 5;
export const MAX_MESSAGES_PER_POLL = 50;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DISCORD_CONTENT_BUDGET = 1900;  // 2000 limit - 100 marker reserve
```

### Failure handling matrix

| Failure | Detection | Response |
|---|---|---|
| Both env vars absent | env check at startup | Skip Discord entirely; E behavior |
| One env var absent (partial config) | env check at startup | Emit one-time stderr warning; skip Discord |
| 401 invalid token | first call | Log once, `ensureChannel` returns null, F path effectively disabled for the run |
| 403 missing perms | any call | Log once, return null, fall back to terminal |
| 429 rate limited | response code | `withRateLimitBackoff` honoring `Retry-After` |
| 404 channel/guild missing | any call after success | Invalidate cache for slug; emit warning; resolver invokes `args.fallback()` |
| Content empty | broadcast input | `publish` returns null + emit StreamChunk warning |
| Content > 1900 chars | broadcast input | Split at paragraph/newline boundary; post sequentially with `… (continued)` markers |
| Leader transient error | `leader.generate` throws | Counter `leaderFailures`; ≥3 → invoke `fallback()` |
| Malformed leader JSON | parse error | Treat as `intent: "discuss"`; reply "Cho phép tôi suy nghĩ lại…"; continue (but counter increments) |
| Unknown intent string | not in {accept, reject, abort, discuss} | Counter `unknownIntents`; ≥5 → invoke `fallback()`; else treat as discuss |
| Customer 24h silence | resolver timeout | Return `{verdict:"abort", feedback:"[timeout-24h]"}` |
| Budget below `VERDICT_FLOOR` | per-iteration check | Post deterministic msg; return `{verdict:"abort", feedback:"budget-exhausted"}` |
| Per-sprint msg cap reached | counter | Post deterministic msg; invoke `fallback()` |
| Two customer messages same poll | natural | Process chronologically; first message reaching terminal intent wins |
| Customer message deleted | absent from getChannelMessages | No-op; continue loop |
| Customer edited message | same id, new content | Discord docs: edits don't change id; F ignores edits (documented limitation) |
| Stakeholder added to nonexistent channel | cache miss | Persist to ACL; grant perms on next `ensureChannel` |
| Corrupt JSON store | parse error | Back up to `${file}.corrupt-${ts}`; reinitialize; warn |
| Wrong schema version | `version > 1` | Refuse + log; do not migrate (T17-style migrators added when v2 exists) |
| Concurrent process writes | file race | `withFileLock` (per file path); read-modify-write inside lock |
| Concurrent same-product `/ideal` in 2 terminals | both poll + reply | Documented as known limitation; recommend single-terminal usage. Lockfile on slug-scoped verdict-mode entry deferred to future (would require cross-process slug lock at run level). |
| cap_usd = 0 boundary | floor = $0.10 | First `remainingUsd()` check immediately aborts (correct behavior) |
| `addChannelPermission` 50007/50013 | API error code | Print actionable CLI error; ACL still persisted; exit 0 |
| Malformed user ID in `share` | regex check | Print error before any API call |
| Disk full during atomic write | ENOSPC on rename | `atomicWriteText` leaves original intact (existing invariant); propagate error |

### Testing strategy

**Unit (mocked `DiscordClient`):**
- `product-identity.test.ts` (8 tests): slug stability across whitespace/case; slugify Unicode; length cap; Discord-name round-trip (lowercase + replace).
- `stakeholder-acl.test.ts` (8 tests): add (idempotent), remove, list, persistence round-trip, corrupt file backup, wrong-version refusal, concurrent-write via file lock.
- `channel-manager.test.ts` (12 tests): cache hit, cache-miss-name-found, cache-miss-create, perm-sync from ACL, 401/403 return null, eager flag pre-creates, in-process concurrent dedup, hook fires on create, `clearChannelCreatedHooks()` between tests, 429 backoff, 404 invalidation, atomic write under lock.
- `broadcast-bus.test.ts` (7 tests): publish happy, 429, 404, 403, empty content, content > 1900 chars (splits), Unicode/emoji preserved.
- `verdict-resolver.test.ts` (16 tests): happy accept, reject with feedback, abort, timeout, VERDICT_FLOOR boundary, cap_usd=0, MAX_VERDICT_MESSAGES_PER_SPRINT cap, malformed JSON → discuss, unknown-intent cap → fallback, leader transient failure cap → fallback, 404 → fallback, cursor-advance after reply, cursor replay on resume after crash, multi-message single poll (>50), customer-message-deleted no-op, partial conversational language.
- `intent-prompt.test.ts` (5 tests): prompt structure, language detection instruction, negation case in classifier mock, emoji-only handling, prior-conversation truncation.
- `share-cmd.test.ts` (9 tests): `--product` wins, latest-run fallback, missing-channel warning, malformed user-id, snowflake passthrough, `<@id>` parse, idempotent re-add informative, 50007/50013 handled, audit line written.
- `client.test.ts` (6 tests): URL composition, header auth, 429 Retry-After honored, 400 on empty content, JSON serialization of emoji, fetch injection.

**Integration (still mocked client):**
- `discord-integration.test.ts` (6 tests):
  - E2E broadcast: phase-runner emits push_notification → channel post → terminal yield continues.
  - E2E verdict: simulate customer messages → bot replies → returns accept verdict.
  - E2E bot kicked mid-verdict → falls back to terminal.
  - E2E env vars absent → existing E tests untouched (regression smoke).
  - E2E `muonroi share` before channel exists → channel created later inherits perms.
  - E2E partial env config (token only) → warns + skips Discord.

**Test seams:**
- `DiscordClient` interface (mockable).
- `sleep(ms)` injected into resolver and broadcast-bus.
- `now()` injected.
- `fetch` injected into `DiscordRestClient` constructor.
- `pollIntervalMs` / `timeoutMs` overridable per call.
- `clearChannelCreatedHooks()` in `afterEach`.
- `process.env.MUONROI_DISCORD_TOKEN` / `_GUILD_ID` set/unset per test with restore in `afterEach`.

**Coverage target:** ≥ 92 % statement coverage on every new file (matches E gate).

### Acceptance criteria

1. With both env vars set, the first `push_notification` during a run creates a private channel `muonroi-<slug>` in the guild, with bot + owner as members.
2. `muonroi share @user` (or raw userId) adds the user to `stakeholders.json` and (if channel exists) grants Discord permissions; bot posts confirmation; audit line appended.
3. When `awaitCustomerVerdict` is called and customer replies in the channel, the bot posts a leader-generated reply, classifies intent, and returns the correct verdict tuple to `phase-runner`. `intent=discuss` keeps the loop alive; `accept|reject|abort` exits.
4. Without env vars set, F is invisible: no Discord code path runs, all E tests stay green.
5. Mid-run failure modes (bot kicked, 403, 404) fall back to terminal verdict path via `args.fallback()` — no crashes.
6. 24h of customer silence yields `{verdict:"abort", feedback:"[timeout-24h]"}`.
7. Budget below `VERDICT_FLOOR` mid-verdict yields `{verdict:"abort", feedback:"budget-exhausted"}` with one final post.
8. Per-sprint message cap reached → fallback to terminal with explanatory post.
9. Content > 1900 chars splits across messages; channel order preserved.
10. `tsc --noEmit` clean; `biome check src/discord src/product-loop/product-identity.ts src/product-loop/stakeholder-acl.ts src/cli/share-cmd.ts src/utils/slugify.ts src/utils/rate-limit.ts src/utils/file-lock.ts` clean.
11. ≥ 92 % coverage on each new file.
12. Full vitest suite passes with no regressions vs E baseline.
13. Partial env config (one of token/guild) emits warning + skips Discord — no crash.

---

## 5. Cost & budget (revised after cost review)

| Operation | LLM calls | Cost (Sonnet 4.6 @ $3/M in, $15/M out) |
|---|---|---|
| Channel create / broadcast | 0 | $0 |
| Stakeholder add | 0 | $0 |
| Per customer message (≈1500 in + 400 out) | 1 | ~$0.011 |
| Verdict, typical (3–5 messages) | 3–5 | ~$0.033–$0.055 |
| Verdict, worst (per-sprint cap = 20 msgs) | 20 | ~$0.22 (capped by `MAX_VERDICT_MESSAGES_PER_SPRINT`) |
| Customer 24h silence | 0 | $0 |
| Per-sprint Discord cost (review summary + verdict typical) | 4–6 | ~$0.13–$0.17 |
| Per-phase Discord cost (3–6 sprints) | 12–36 | ~$0.40–$1.00 |
| E + F per-phase combined | — | ~$1.15–$2.50 (well within default $10 cap) |

### PHASE_HINTS impact

E's `review` hint (0.03 × capUsd = $0.30 at cap=$10) was sized for the leader review summary alone (~$0.12). F's verdict capture adds ~$0.08–$0.22 per sprint, pushing `review` bucket toward $0.20–$0.34. **At cap=$10 this overflows the 0.03 hint slightly (worst case 0.034).**

**Plan-stage action:** F's first task includes a phase-budget rebalance:
- `review` 0.03 → 0.03 (unchanged; leader review only)
- `verdict` 0.00 → 0.02 (new; Discord verdict only; gated by env)
- `sprint` 0.30 → 0.28 (reduce by 0.02 to keep total 1.0)

Plan-stage will document the migration: when Discord is disabled, the `verdict` budget allotment effectively returns to `sprint`.

---

## 6. File map (revised)

**Shared utility extractions (new) — done first in plan stage so other files can depend on them:**

| File | Source | Reason |
|---|---|---|
| `src/utils/rate-limit.ts` (§6.A0) | Extracted from `src/product-loop/discovery-recommender.ts:244` | Layer A in `src/discord/` must not depend on `src/product-loop/`. Existing callers in `phase-plan.ts`, `phase-rituals.ts`, `context-policy.ts` re-export from the new location. |
| `src/utils/slugify.ts` (§6.A1.a) | Extracted from private `slugifyTitle` in `ship-polish.ts` | Shared by `productSlug` and any future caller. |
| `src/utils/file-lock.ts` (§6.A1.b) | New | `withFileLock(path, fn)` cross-process advisory lock. Used by stakeholder-acl and channel-manager writes. Implementation: pure node `fs.open` with `wx` flag on `${path}.lock` + retry-on-EEXIST with exponential backoff (no external dep needed — pattern review noted `proper-lockfile` is not used elsewhere in the repo). |

**New Discord files (6, in `src/discord/`):**

| File | Responsibility |
|---|---|
| `client.ts` | `DiscordRestClient`, `DiscordClient` interface, `DiscordMessage` |
| `channel-manager.ts` | `ensureChannel`, channel-mapping I/O with lock, hook list, `clearChannelCreatedHooks` |
| `broadcast-bus.ts` | `publish` with 429/404/empty/oversize handling |
| `verdict-resolver.ts` | `discordAwaitVerdict` poll loop with constants |
| `intent-prompt.ts` | `SYSTEM_PROMPT`, `buildConvoPrompt`, `parseConvoReply` |
| `types.ts` | `DiscordClient`, `DiscordMessage`, `DiscordChannelMapping`, `PollCursor`, `BroadcastType` |
| `verdict-constants.ts` | Numeric constants from §4 |

**New product-loop additions (2):**

| File | Responsibility |
|---|---|
| `src/product-loop/product-identity.ts` | `productSlug` |
| `src/product-loop/stakeholder-acl.ts` | Stakeholder types + add/remove/list with lock |

**New CLI (1):**

| File | Responsibility |
|---|---|
| `src/cli/share-cmd.ts` | `muonroi share` command |

**Modified files (4):**

| File | Change |
|---|---|
| `src/product-loop/index.ts` | When Discord env vars set: intercept `phaseGen` yield to broadcast; swap `awaitCustomerVerdict` to `discordAwaitVerdict`. Handle partial env config warning. |
| `src/product-loop/phase-budget.ts` | Add `verdict` to `Phase` union; rebalance `PHASE_HINTS` (sprint 0.30→0.28, verdict 0.02); bump `BudgetState` schema (versioned migration consistent with T2 pattern). |
| `<actual CLI entry-point>` | Register `share` subcommand. Plan stage's first task confirms the file (likely `src/cli.ts` per package.json `bin` — pattern review flagged that `src/cli/index.ts` does not exist). |
| `src/product-loop/discovery-recommender.ts` | Re-export `withRateLimitBackoff` from `src/utils/rate-limit.ts` (backwards-compat shim; existing callers continue to import from old path). |

**Test files (10):**

- `src/discord/__tests__/client.test.ts`
- `src/discord/__tests__/channel-manager.test.ts`
- `src/discord/__tests__/broadcast-bus.test.ts`
- `src/discord/__tests__/verdict-resolver.test.ts`
- `src/discord/__tests__/intent-prompt.test.ts`
- `src/discord/__tests__/discord-integration.test.ts`
- `src/product-loop/__tests__/product-identity.test.ts`
- `src/product-loop/__tests__/stakeholder-acl.test.ts`
- `src/cli/__tests__/share-cmd.test.ts`
- `src/utils/__tests__/file-lock.test.ts` (covers the new shared util)

(`rate-limit.test.ts` and `slugify.test.ts` extensions reuse existing test cases against the new module locations.)

---

## 7. Forward-compat audit (for Subsystem G)

| Extension point | Defined in F | How G uses it |
|---|---|---|
| `productSlug(idea)` | `src/product-loop/product-identity.ts` | Names VM/container/workspace dir. |
| `slugify(text)` | `src/utils/slugify.ts` | Reused for env names / file paths. |
| `withFileLock(path, fn)` | `src/utils/file-lock.ts` | Reused for any cross-process state G adds. |
| `stakeholder-acl` API | `src/product-loop/stakeholder-acl.ts` | Reads same list to populate SSH `authorized_keys` / workspace owner ACL. |
| `broadcast-bus.publish(type)` with `env-provisioning | env-ready | env-teardown` | `src/discord/broadcast-bus.ts` | Publishes env lifecycle events. |
| `ensureChannel(opts.eager)` | `src/discord/channel-manager.ts` | Calls with `eager: true` at run start so env-status messages have a channel. |
| `registerChannelCreatedHook(fn)` + `clearChannelCreatedHooks()` | `src/discord/channel-manager.ts` | Subscribes to post env intro message. Test isolation via the clear API. |

These hooks add zero runtime overhead when G is absent — inert API surface.

---

## 8. Open questions deferred to plan stage

- Exact format of `buildConvoPrompt` truncation when prior conversation exceeds context cap (likely use the existing oldest-first decay pattern from `context-policy.ts`).
- Whether to use `proper-lockfile` (adds dep) or hand-rolled `fs.open` retry (no dep) — **decision noted: hand-rolled**, see §6.A1.b.
- Plan-stage Task 0: confirm CLI entry-point file (likely from `package.json bin`).
- Whether `muonroi share` accepts comma-separated users in one invocation (defer — v1 single user).
- i18n for deterministic bot messages (budget-exhausted, timeout, cap-reached). Defer; English+Vietnamese plaintext only in v1.
- Cross-process slug-level lock during verdict polling (to prevent doubled bot replies when two terminals run `/ideal` on same product). **Documented as a known limitation** in §4 failure matrix; full fix deferred. Recommend single-terminal usage for v1.

---

## 9. Changelog vs v1

Cross-review on v1 surfaced 49 findings (15 Critical, 24 Important, 10 Nit). Critical findings applied to v2:

| # | Source | Change |
|---|---|---|
| Arch-C1 | Architecture review | Wiring intercepts `phaseGen` yield in `index.ts`, NOT the `sprintRunner` adapter. |
| Arch-C2 | Architecture review | `leader.generate` transient failures bounded at `MAX_LEADER_FAILURES_BEFORE_FALLBACK=3`. |
| Arch-C3 | Architecture review | `withFileLock` wraps all global JSON writes (stakeholder-acl + channel-manager). |
| Cost-C1 | Cost review | `MAX_VERDICT_MESSAGES_PER_SPRINT` cap added. |
| Cost-C2 | Cost review | Dedicated `VERDICT_FLOOR = max(0.10, 0.01×capUsd)` (replaces handoff floor reuse). |
| Pattern-C1 | Pattern review | All global JSON files at `${muonroiHome()}/...` (= `~/.muonroi-cli/`), matching existing convention. |
| Test-C1 | Test review | Empty-content broadcast returns null + warning. |
| Test-C2 | Test review | In-process dedup for concurrent `ensureChannel(slug)`. |
| Test-C3 | Test review | Content > 1900 chars split at paragraph/newline boundary. |
| Test-C4 | Test review | Cursor advance AFTER successful publish (not before leader call). |
| Test-C5 | Test review | Pagination of `>50` messages documented. |
| Test-C6 | Test review | Corrupt-JSON recovery + atomic-write invariant called out explicitly. |
| Test-C7 | Test review | Doubled-replies on concurrent same-product `/ideal` documented as known limitation. |
| Test-C8 | Test review | Partial env config (one of token/guild) emits warning. |
| Test-C9 | Test review | `cap_usd=0` boundary handled (floor=$0.10 → immediate abort). |

Important findings applied:
- `withRateLimitBackoff` extracted to `src/utils/rate-limit.ts` (Arch-I4).
- `BroadcastType` union expanded to include G's events explicitly (Arch-I9).
- `onChannelCreated` exposed via getter/clearer API (Arch-I6).
- Slug-Discord round-trip normalization (Arch-I7).
- `MAX_UNKNOWN_INTENT_BEFORE_FALLBACK` for malformed/confused leader replies (Arch-I5).
- `share-cmd` audit via `appendSystemMessage` (Pattern-I8).
- Plan Task 0 confirms CLI entry-point file before subcommand registration (Pattern-I7).
- `share` handles 50007/50013 with actionable error + persisted ACL (Test-I).
- 401/403 token/guild errors emit one-time warning, not silent (Test-I).
- `phase-budget.ts` adds `verdict` bucket; rebalance to keep hints sum 1.0 (Cost-I3).

Nit findings:
- Cost estimate revised from $0.02/msg → $0.011/msg (Cost-N1).
- Edits-don't-change-id limitation documented (Test-N).
- Wrong-schema-version refusal documented (Test-I + Pattern-N).
