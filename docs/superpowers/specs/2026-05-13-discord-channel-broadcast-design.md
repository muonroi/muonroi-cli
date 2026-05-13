# Subsystem F — Discord Channel-per-Product Design Spec

**Date:** 2026-05-13
**Author:** muonroi
**Status:** Approved by user (sections 1–4)
**Builds on:** Subsystem E (phase orchestrator, commits 27fb4a2 → 8408db0)
**Forward-compat for:** Subsystem G (env initialization — VM/container provisioning) — extension points called out below.

---

## 1. Goal & Scope

### Goal

Make a Discord channel the primary customer/stakeholder touchpoint during a product run. The bot (1) lazily creates a private channel per product, (2) broadcasts every `push_notification` chunk (sprint review, retro, standup) into the channel, and (3) conducts a free-form conversational verdict capture loop with the customer in the channel — replacing the terminal `awaitCustomerVerdict` from E when Discord is configured. The CLI gains a `muonroi share` command to grant channel access to a Discord user.

### In-scope

1. Channel-per-product, find-or-create keyed on `productSlug = sha1(idea).slice(0,8) + "-" + slugify(idea).slice(0,40)`.
2. Lazy create — trigger on first `push_notification` chunk for a product.
3. Private channel; bot grants view+post permission via `muonroi share <user-id-or-@mention>`.
4. Broadcast: every `StreamChunk { type: "push_notification" }` posted to the channel when Discord is configured. Chunk also still yields to terminal (additive, not replacing).
5. Conversational verdict: `awaitCustomerVerdict` replaced by a Discord polling loop that classifies customer messages into `accept | reject | abort | discuss` via leader LLM and posts a reply each turn.
6. CLI: `muonroi share <user> [--product <slug>]` to add a stakeholder.
7. Opt-in via `MUONROI_DISCORD_TOKEN` + `MUONROI_DISCORD_GUILD_ID` env. Absent → E behavior unchanged (terminal-only).

### Out-of-scope (defer)

- Gateway WS / real-time event subscriptions (REST polling only).
- Slash commands inside Discord (`/accept`, etc.).
- Auto-archive channel after N days idle.
- Secret/PII scrubbing (user owns what they share into the channel).
- Multi-tenant bot (one bot serving many users).

### Forward-compat for Subsystem G

G is the next subsystem: it provisions an isolated environment (VM, container, workspace dir) per product when the run starts. F is designed so G plugs in without breaking changes. Key extension points:

- `productSlug()` is a shared utility — G reuses the same slug for env naming.
- `stakeholder-acl.ts` is product-scoped and Discord-agnostic — G reads the same list to set SSH/workspace ACLs.
- `broadcast-bus.publish(slug, type, content)` accepts open-ended `type` strings; G publishes `env-provisioning`, `env-ready`, `env-teardown` through the same API.
- `ensureChannel(slug, displayName, { eager?: boolean })` accepts an `eager: true` override — G can pre-create the channel at run start to announce env lifecycle.
- F exports an `onChannelCreated(slug, channelId)` hook list — G subscribes to post an intro message when env comes online.

---

## 2. Architecture

Eight layers, each with a single responsibility and a typed interface.

### Layer A — Discord REST client

**File:** `src/discord/client.ts`

Thin wrapper around `fetch` for Discord REST v10. Reuses `withRateLimitBackoff` from `src/product-loop/discovery-recommender.ts`. No SDK dependency.

```ts
export interface DiscordClient {
  createChannel(guildId: string, name: string, opts: { topic?: string; isPrivate?: boolean }): Promise<{ id: string }>;
  getChannelMessages(channelId: string, opts: { afterId?: string; limit?: number }): Promise<DiscordMessage[]>;
  postMessage(channelId: string, content: string): Promise<{ id: string }>;
  addChannelPermission(channelId: string, userId: string, allow: number, deny: number): Promise<void>;
  getCurrentUserId(): Promise<string>;  // for filtering bot's own messages
  listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>>;
}
```

Concrete impl: `new DiscordRestClient(token, fetch)`. Tests inject a `MockDiscordClient`.

### Layer B — Product identity (shared with G)

**File:** `src/product-loop/product-identity.ts` (new)

```ts
export function productSlug(idea: string): string;
// e.g. productSlug("Blog platform with auth")
//   → "a3b91c02-blog-platform-with-auth"
//   = sha1 8-char prefix + "-" + slugify(idea).slice(0,40)
```

Stable: same idea text → same slug forever. Used by F for channel name and by G for env name.

### Layer C — Stakeholder ACL (shared with G)

**File:** `src/product-loop/stakeholder-acl.ts` (new)

Persists at `~/.muonroi/stakeholders.json`:

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

Idempotent: re-adding same `discordUserId` is a no-op.

### Layer D — Channel manager

**File:** `src/discord/channel-manager.ts` (new)

```ts
export async function ensureChannel(args: {
  client: DiscordClient;
  guildId: string;
  slug: string;
  displayName: string;
  eager?: boolean;  // reserved for G; default false (lazy)
}): Promise<{ channelId: string; created: boolean } | null>;
// Returns null when Discord is disabled or permission is denied.
```

Algorithm:
1. Read `~/.muonroi/discord-channels.json` cache; if `slug` present, verify via `listGuildChannels`; if alive, return `{ channelId, created: false }`.
2. Else search guild channels by name (`muonroi-${slug}`); if found, persist mapping, return.
3. Else `createChannel` with type=GUILD_TEXT, isPrivate=true. Topic: `${displayName} — managed by muonroi-cli`.
4. Sync permissions: read stakeholder-acl for slug, call `addChannelPermission` for each.
5. Persist mapping. Invoke `onChannelCreated` hooks. Return `{ channelId, created: true }`.

### Layer E — Broadcast bus (shared event surface)

**File:** `src/discord/broadcast-bus.ts` (new)

```ts
export type BroadcastType = "phase-event" | "env-status" | "custom";
export async function publish(args: {
  client: DiscordClient;
  channelId: string;
  type: BroadcastType;
  content: string;
}): Promise<{ messageId: string } | null>;
```

Wraps `postMessage` with `withRateLimitBackoff`. Returns null on permanent failure (404/403) and emits a one-line StreamChunk warning.

### Layer F — Verdict resolver (replaces `awaitCustomerVerdict`)

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
  pollIntervalMs?: number;  // default 5000; tests override
  timeoutMs?: number;       // default 24h
  sleep?: (ms: number) => Promise<void>;  // injectable
  now?: () => number;       // injectable
  fallback: () => Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
  // ↑ fallback is the terminal respondToQuestion path, invoked when Discord becomes unreachable mid-loop
}): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
```

Poll loop semantics specified in §3.

### Layer G — Stakeholder CLI

**File:** `src/cli/share-cmd.ts` (new)

```
muonroi share <user-id-or-@mention> [--product <slug>] [--display <name>]
```

Resolves product:
- `--product` flag wins.
- Else read most recent run's `manifest.json` from CWD's `.flow/runs/`.
- Else error: "no active product found; pass --product".

Calls `addStakeholder` + (if channel exists) `addChannelPermission` + post `@${displayName} đã được thêm vào product` to the channel.

### Layer H — Wiring & gating

**File:** `src/product-loop/index.ts` (modify in `runPhasesPath`)

When `process.env.MUONROI_DISCORD_TOKEN` and `MUONROI_DISCORD_GUILD_ID` are both set:
- Build `DiscordRestClient`.
- Wrap `sprintRunner` so that any yielded `{ type: "push_notification" }` chunk is also sent to `publish(...)` after `ensureChannel(...)`.
- Replace `awaitCustomerVerdict` with `discordAwaitVerdict(...)`, passing the terminal `respondToQuestion`-based path as `fallback`.

When env vars are absent → no Discord code path executes; E behavior preserved.

---

## 3. Data flow

### Flow 1 — Broadcast

```
phase-runner yields { type: "push_notification", content }
  ↓
index.ts wrapper:
  slug = productSlug(manifest.idea)
  result = await ensureChannel({ client, guildId, slug, displayName: manifest.idea })
  if result: await publish({ client, channelId: result.channelId, type: "phase-event", content })
  ↓
yield the chunk onward to terminal (do not swallow)
```

### Flow 2 — Conversational verdict

```
phase-runner: awaitCustomerVerdict() called
  ↓
discordAwaitVerdict:
  1. ensureChannel(slug)  // already created on first broadcast, cache hit expected
  2. publish(channelId, "phase-event", reviewSummary + "\n\nReply trong channel để feedback...")
  3. lastSeenId = read PollCursor for (phaseId, sprintN) OR id of message just posted
  4. startedAt = now()
  ↓
  loop:
    if now() - startedAt > timeoutMs: return { verdict: "abort", feedback: "[timeout-24h]" }
    if remainingUsd() < floor: post deterministic budget-exhausted msg; return { verdict: "abort", feedback: "budget-exhausted" }
    msgs = client.getChannelMessages(channelId, { afterId: lastSeenId, limit: 50 })
           .filter(m => m.author.id !== botUserId)
    if msgs.length === 0:
      await sleep(pollIntervalMs)
      continue
    for msg in msgs (chronological):
      lastSeenId = msg.id
      persistPollCursor(phaseId, sprintN, lastSeenId)
      // single combined leader call → response + intent
      raw = await leader.generate({
        system: SYSTEM_PROMPT,
        prompt: buildConvoPrompt(reviewSummary, priorN=5, msg),
        maxTokens: 400,
      })
      parsed = parseConvoReply(raw.content)  // tolerant JSON parser; intent="discuss" on parse fail
      await publish(channelId, "phase-event", parsed.reply)
      if parsed.intent in {accept, reject, abort}:
        return {
          verdict: parsed.intent,
          feedback: parsed.intent === "accept" ? undefined : msg.content
        }
      // else discuss: keep looping
```

If `client.getChannelMessages` throws 404 or 403 (channel deleted / bot kicked) at any point: invalidate cache for `slug`, emit warning, invoke `args.fallback()`.

### Flow 3 — Stakeholder add

```
muonroi share @<userId> [--product <slug>]
  ↓
1. slug = --product OR resolveLatestProductSlug(cwd)
2. addStakeholder(slug, { discordUserId, displayName, addedAtUtc: now, addedBy: "cli" })
3. mapping = readChannelMapping(slug)
4. if !mapping: print "Channel will be granted access on creation."; exit 0
5. client.addChannelPermission(mapping.channelId, userId, allow=VIEW+SEND+READ_HISTORY, deny=0)
6. client.postMessage(mapping.channelId, `@${displayName} đã được thêm vào product`)
```

### Intent classification prompt (single combined call)

```
System: "You are the PO leading product '${productName}'. Read the customer's most recent message in the Discord channel and decide their intent. Reply concisely in the language the customer used (default Vietnamese). Output strict JSON ONLY (no code fences):
{
  \"intent\": \"accept\" | \"reject\" | \"abort\" | \"discuss\",
  \"reply\": string (≤500 chars)
}

intent semantics:
  - accept: customer is satisfied with this sprint, ready to move on.
  - reject: customer wants changes but continue product (will iterate next sprint).
  - abort: customer wants to stop the entire product (cut losses, wrong direction).
  - discuss: customer asks a question, shares info, or is undecided. No verdict yet.

Be conservative: when in doubt, choose 'discuss'."

Prompt:
  Sprint review summary:
    <reviewSummary>

  Prior conversation (last 5 turns; chronological):
    customer: <m1>
    bot: <r1>
    ...

  New customer message:
    <msg>
```

### Cost guard

Per leader call (one per customer message) gated by `remainingUsd > max(0.05, 0.005 * capUsd)` (matches handoff floor in E). Below floor → post deterministic msg ("Budget exhausted; reply via terminal `/loop` to continue") and return `{verdict: "abort", feedback: "budget-exhausted"}`.

---

## 4. Schemas, persistence, error handling, testing

### Persisted artifacts

| File | Scope | Shape |
|---|---|---|
| `~/.muonroi/stakeholders.json` | global, cross-run | `{ version: 1, items: Record<slug, { productSlug, stakeholders: Stakeholder[] }> }` |
| `~/.muonroi/discord-channels.json` | global, cross-run | `{ version: 1, items: Record<slug, DiscordChannelMapping> }` |
| `state.md` section `Discord Poll Cursor` | per-run | `{ version: 1, cursors: PollCursor[] }` indexed by `(phaseId, sprintN)` |

All writes use atomic-write where the existing infra supports it (`atomicWriteText` for JSON; section-map abstraction for `state.md`).

### Failure handling matrix

| Failure | Detection | Response |
|---|---|---|
| `MUONROI_DISCORD_TOKEN` not set | env check at startup | Skip Discord entirely; F is opt-in. |
| `MUONROI_DISCORD_GUILD_ID` not set | env check at startup | Same. |
| Discord 429 | response status + `Retry-After` header | `withRateLimitBackoff` honoring header |
| Bot lacks channel-create permission | 403 on `createChannel` | Log warn; `ensureChannel` returns `null`; broadcast & verdict fall back to terminal |
| Bot kicked from guild | 404 on subsequent calls | Invalidate cache entry for slug; warn; verdict resolver calls `args.fallback()` |
| Channel deleted by user | 404 on `postMessage`/`getChannelMessages` | Same as bot-kicked |
| Customer silent ≥ 24h | resolver timeout | Return `{verdict: "abort", feedback: "[timeout-24h]"}` |
| Budget below floor | `remainingUsd() < max(0.05, 0.005*capUsd)` | Post deterministic budget-exhausted msg; return abort |
| Malformed leader JSON | parse error in `parseConvoReply` | Treat as `intent: "discuss"`; reply "Cho phép tôi suy nghĩ lại..."; continue polling |
| Two customer messages in one poll window | natural | Process chronologically; first message reaching a terminal intent wins |
| Stakeholder added to nonexistent channel | cache miss | Persist to ACL; grant perms on next `ensureChannel` |
| `~/.muonroi/*.json` corrupt | JSON.parse error | Back up to `${file}.corrupt-${ts}` and start fresh (matches T12 pattern) |
| Concurrent `muonroi share` invocations | file race | Lock with `proper-lockfile` if available; otherwise read-modify-write within try/catch loop with retry |

### Testing strategy

**Unit (mocked `DiscordClient`):**
- `product-identity.test.ts` — slug stability, slugify, prefix length, idempotence on whitespace/case.
- `stakeholder-acl.test.ts` — add (idempotent), remove, list, persistence round-trip, corrupt file backup.
- `channel-manager.test.ts` — cache-hit, cache-miss-name-found, cache-miss-create, perm-sync from ACL, 403 returns null, eager flag pre-creates.
- `broadcast-bus.test.ts` — publish happy path, 429 backoff, 404 returns null + warning.
- `verdict-resolver.test.ts` — happy accept, reject with feedback, abort, timeout, budget floor, malformed JSON → discuss, 404 falls back, multi-message single poll, cursor persistence + replay on resume.
- `share-cmd.test.ts` — `--product` flag wins, latest-run fallback, missing channel warning.
- `discord-rest-client.test.ts` — fetch URL composition, header auth, 429 retry honored.

**Integration (still mocked client):**
- E2E: phase-runner emits push_notification → broadcast posts → verdict capture loop → returns accept.
- E2E: Discord env vars absent → existing E tests pass unchanged (no regression).
- E2E: Bot kicked mid-verdict → resolver falls back to terminal `respondToQuestion`.
- E2E: `muonroi share` adds stakeholder before channel exists → channel created later inherits perms.

**Test seams:**
- `DiscordClient` interface (mockable).
- `sleep(ms)` injected into resolver (default `setTimeout`; tests fast-forward).
- `now()` injected (default `Date.now`).
- `fetch` injected into `DiscordRestClient` constructor.
- `pollIntervalMs` and `timeoutMs` overridable per call.

**Coverage target:** ≥ 92 % statement coverage on every new file (matches E gate).

### Acceptance criteria

1. With `MUONROI_DISCORD_TOKEN` + `MUONROI_DISCORD_GUILD_ID` set, the first `push_notification` chunk during a run causes a private channel `muonroi-<slug>` to be created in the guild, with bot + owner as members.
2. `muonroi share @user` (or raw userId) adds the user to `~/.muonroi/stakeholders.json` and (if channel exists) grants Discord permissions; bot posts confirmation message.
3. When `awaitCustomerVerdict` is called and customer replies in the channel, the bot posts a leader-generated reply, classifies intent, and returns the correct verdict tuple to `phase-runner`. `intent=discuss` keeps the loop alive; `accept|reject|abort` exits.
4. Without the env vars set, F is invisible: no Discord code path runs, all E tests stay green.
5. Mid-run failure modes (bot kicked, 403, 404) fall back to the terminal verdict path via `args.fallback()` — no crashes.
6. 24 h of customer silence yields `{verdict:"abort", feedback:"[timeout-24h]"}`.
7. Budget below floor mid-verdict yields `{verdict:"abort", feedback:"budget-exhausted"}` with one final post.
8. `tsc --noEmit` clean, `biome check src/discord src/product-loop/product-identity.ts src/product-loop/stakeholder-acl.ts src/cli/share-cmd.ts` clean.
9. ≥ 92 % coverage on each new file.
10. Full vitest suite passes with no regressions vs E baseline.

---

## 5. Cost & budget summary

| Operation | LLM calls | Approx. cost @ Sonnet 4.6 |
|---|---|---|
| Channel create + broadcast | 0 | $0 |
| Stakeholder add | 0 | $0 |
| Per customer message (response + intent) | 1 | ~$0.02 |
| Verdict capture, typical (3-5 exchanges) | 3–5 | ~$0.06–$0.10 |
| Verdict capture, worst (timeout after 100 msgs) | up to 100 | ~$2.00 (gated by `max(0.05, 0.005*capUsd)` floor) |

Effective worst-case under default `capUsd=$10` floor: floor = $0.05, so resolver aborts when remaining < $0.05 — caps verdict cost at ~`$capUsd - $0.05`. Realistic per-sprint Discord verdict cost: **$0.08–$0.20**.

Subsystem E baseline + F addition: still well within typical `$10` cap.

---

## 6. File map

**New files (9):**

| File | Responsibility |
|---|---|
| `src/discord/client.ts` | `DiscordRestClient` (REST wrapper) + `DiscordClient` interface + `DiscordMessage` types |
| `src/discord/channel-manager.ts` | `ensureChannel`, channel-mapping cache I/O, `onChannelCreated` hook list |
| `src/discord/broadcast-bus.ts` | `publish` with 429/404 handling |
| `src/discord/verdict-resolver.ts` | `discordAwaitVerdict` poll loop |
| `src/discord/intent-prompt.ts` | `SYSTEM_PROMPT`, `buildConvoPrompt`, `parseConvoReply` |
| `src/discord/types.ts` | `DiscordClient`, `DiscordMessage`, `DiscordChannelMapping`, `PollCursor`, `BroadcastType` |
| `src/product-loop/product-identity.ts` | `productSlug` |
| `src/product-loop/stakeholder-acl.ts` | `Stakeholder*` types + `listStakeholders` / `addStakeholder` / `removeStakeholder` |
| `src/cli/share-cmd.ts` | `muonroi share` command |

**Modified files (3):**

| File | Change |
|---|---|
| `src/product-loop/index.ts` | When Discord env vars set: wrap `sprintRunner` to also broadcast, replace `awaitCustomerVerdict` with `discordAwaitVerdict`. |
| `src/cli/index.ts` (or wherever the CLI command router lives) | Register `share` subcommand. |
| `src/types/index.ts` | (No new types needed — `push_notification` already added in E.) |

**Test files (8):**

- `src/discord/__tests__/client.test.ts`
- `src/discord/__tests__/channel-manager.test.ts`
- `src/discord/__tests__/broadcast-bus.test.ts`
- `src/discord/__tests__/verdict-resolver.test.ts`
- `src/discord/__tests__/intent-prompt.test.ts`
- `src/product-loop/__tests__/product-identity.test.ts`
- `src/product-loop/__tests__/stakeholder-acl.test.ts`
- `src/cli/__tests__/share-cmd.test.ts`
- `src/discord/__tests__/discord-integration.test.ts` (e2e mocked-client integration)

---

## 7. Forward-compat audit (for Subsystem G)

| Extension point | Defined in F | How G uses it |
|---|---|---|
| `productSlug(idea)` | `src/product-loop/product-identity.ts` | Names VM/container/workspace dir. |
| `stakeholder-acl` API | `src/product-loop/stakeholder-acl.ts` | Reads same list to populate SSH authorized_keys / workspace owner ACL. |
| `broadcast-bus.publish(type)` | `src/discord/broadcast-bus.ts` | Publishes `env-provisioning`, `env-ready`, `env-teardown` with custom `type`. |
| `ensureChannel(opts.eager)` | `src/discord/channel-manager.ts` | Calls with `eager: true` at run start so env-status messages have a channel to post into. |
| `onChannelCreated` hook list | `src/discord/channel-manager.ts` | Subscribes to post an "Environment is provisioning…" intro when channel comes online. |

These hooks add zero runtime overhead when G is absent — they're inert API surface.

---

## 8. Open questions deferred to plan stage

- Exact format of `buildConvoPrompt` truncation when prior conversation exceeds context cap.
- Whether to use `proper-lockfile` for the JSON store or hand-rolled retry-on-EBUSY loop.
- Whether `muonroi share` accepts a comma-separated list of users in one invocation (YAGNI: probably v1 = single user; multi-user can be a flag later).
- Localization: prompt asks customer to reply in their language; should the deterministic bot messages also be localized via `i18n`? Defer.
