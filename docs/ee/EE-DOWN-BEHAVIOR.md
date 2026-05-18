# EE Down: Graceful Degradation Reference

What happens when the Experience Engine (EE) is unreachable, throttled, or
explicitly disabled. Use this doc when investigating "why didn't the warning
fire / context get injected" or when planning offline / air-gapped runs.

## Overview — Which features depend on EE

| Feature | EE call site | Hard dep? |
|---|---|---|
| PreToolUse `intercept` warnings (`⚠ [Experience]`) | `src/ee/intercept.ts` → `client.intercept` | No — falls open to `allow` |
| PostToolUse / feedback / touch / route-feedback | `src/ee/client.ts` (fire-and-forget) | No — silent swallow + offline queue |
| PIL Layer 3 enrichment (principles + behavioral hints injected into the model prompt) | `src/pil/layer3-ee-injection.ts` → `searchByText` | No — returns the pipeline ctx untouched, marks layer `applied: false`, logs `error=...` delta |
| `/ideal` BB-aware council context (Phase 5.x) | `src/ee/bb-retrieval.ts` → `fetchBBContext` | No — returns empty `BBContext`, council runs without recipes/behavioral/packages |
| `/doctor`, `usage stats`, `/timeline`, `/graph`, `/gates`, `/evolve`, `share`/`import` principle | `src/ee/client.ts` (`stats`, `graph`, `timeline`, …) | Yes for the command — returns `null` and the command renders an empty/error state |
| Cold-start route + per-model routing | `client.routeModel` / `client.coldRoute` | No — return `null`, caller falls back to default model selection |
| PIL unified context (`/api/pil-context`) | `client.pilContext` | No — returns `null`, Layer 3 falls back to direct `searchByText` calls |
| Brain proxy (used as one Layer 1 source) | `client.brainProxy` | No — returns `null`, downstream layer uses its own fallback |

Nothing in the orchestrator hard-fails when EE is down. The TUI keeps streaming;
the only user-visible change is missing experience hints / BB context.

## Failure modes per call site

All references below are at the locations noted; see source for current line
numbers if the file has been edited.

### `src/ee/client.ts` — `intercept(req)` (around line 259)

- **Timeout**: 100ms for `localhost` / 127.0.0.1, 10 000ms for remote bases
  (see `defaultTimeoutForBase`). Aborted via `AbortSignal.timeout`.
- **Cache hit** (5-min TTL, 200 entries, `allow`-only): 0 ms — no network.
- **Circuit breaker open** (3 consecutive failures, 30 s open window, single
  half-open probe): returns `{ decision: "allow", reason: "circuit-open" }`
  in 0 ms — no network.
- **HTTP 401**: returns `{ decision: "allow", reason: "auth-required" }`;
  `intercept.ts` then calls `refreshAuthToken()` and retries exactly once.
- **HTTP non-2xx** (other): `logUnreachable` (rate-limited 1×/60 s),
  `recordCircuitFailure()`, returns `{ decision: "allow", reason: "ee-unreachable" }`.
- **Network throw / timeout**: same as non-2xx — logs once per minute,
  bumps circuit counter, returns `allow`.
- **User-visible impact**: no warning ⚠ lines surface for that tool call.
  Tool still runs (we fail open, never block on EE).

### `src/ee/client.ts` — `posttool` / `feedback` / `touch` / `routeFeedback` (around lines 296–373)

- **Fire-and-forget**: no `await`-able error path. `feedback` falls back to
  `offline-queue.enqueue()` on rejection; the queue is drained the next time
  a successful EE call records a circuit success.
- **User-visible impact**: zero — telemetry is best-effort.

### `src/ee/client.ts` — `routeModel` / `coldRoute` (around lines 306–342)

- **Timeout**: 250 ms (`routeModel`), 1000 ms (`coldRoute`). Honours an
  externally-supplied `AbortSignal`.
- **Non-2xx / throw**: returns `null`. Callers fall back to the
  user-configured default model.

### `src/ee/client.ts` — `promptStale` / `extract` (around lines 376–413)

- **Timeout**: 2 000 ms / 10 000 ms.
- **Non-2xx / throw**: enqueues into `offline-queue` for replay, returns `null`.
  Prompt-stale reconciliation skips this cycle; nothing breaks downstream.

### `src/ee/client.ts` — `stats` / `graph` / `timeline` / `gates` / `evolve` / `share*` / `import*` / `routeTask` / `search` / `user` / `brainProxy` / `pilContext`

- Each wraps `fetch` in `try/catch` with its own `AbortSignal.timeout(…)`
  (range 1 s–15 s — `evolve` is the longest).
- Any non-OK status or thrown error returns `null`.
- **User-visible impact** depends on caller:
  - `/doctor`, `usage stats`, etc. render "EE unreachable" or skip that
    section.
  - `search` callers (PIL Layer 3, BB-retrieval) treat `null` as "no
    matches" — pipeline proceeds.

### `src/ee/bb-retrieval.ts` — `fetchBBContext(prompt)` (around line 242)

- **Feature flag off** (`userSettings.eeBBContext === false`): returns
  `empty` immediately, latency 0 ms.
- **Auth token load failure**: caught silently, proceeds with `null` token.
- **No `baseUrl` configured**: returns `empty` — silent degrade.
- **Timeout** (default `BB_RETRIEVAL_TIMEOUT_MS`, override via `opts.timeoutMs`):
  triggers `Promise.all` rejection.
- **`Promise.all` rejects** (network error, abort, etc.): logs *once per
  process* to stderr (`[ee.bb] network error fetching BB context: …`),
  returns `empty` with measured `latencyMs`. Loop driver renders nothing,
  council runs with framework-agnostic prompt.
- **Empty recipe collection**: logs *once per process*
  `[ee.bb] no recipe hits — running Phase 3 ingestion would help`.

### `src/pil/layer3-ee-injection.ts` — `queryEeBridge(raw)` (around line 115)

- **Timeout**: `PIL_SEARCH_TIMEOUT_MS` (default 1500 ms; see
  `PIL_PRINCIPLES_FLOOR` / `MUONROI_PIL_SCORE_FLOOR` env override).
- **Throw / abort**: returns
  `{ principlePoints: [], behavioralPoints: [], t1Rules: [], error: <String(err)> }`.
- Caller logs an `ee_injection` event subtype `error` (best-effort
  `logInteraction`, catch-and-ignore), appends a layer with
  `applied: false`, `delta: "error=…"`. The PIL context proceeds without
  experience hints — `t1Rules` becomes `[]`, no MANDATORY RULES block
  appears in Layer 6.

### `src/ee/intercept.ts` — bootstrap + default-client wiring

- `bootstrapEEClient()` calls `loadEEAuthToken()` which itself swallows
  filesystem errors and leaves the cached token `null`. Subsequent
  `getDefaultEEClient()` returns a client with no `Authorization` header;
  the server replies 401 → `intercept` fails open with `auth-required`,
  `refreshAuthToken()` retries once, then the request settles as `allow`.

## Graceful-degradation summary

| Subsystem | EE down outcome | Latency floor | Retry / queue |
|---|---|---|---|
| `intercept` | Fail open (`allow`) | 0–100 ms (local) / 10 s (remote) | Circuit breaker; 401 → refresh + retry once |
| `posttool` / `touch` / `routeFeedback` | Silent drop | n/a | `feedback` only — offline queue + replay on next success |
| `routeModel` / `coldRoute` | `null` → default model | 250 ms / 1 s | none |
| `promptStale` / `extract` | `null` + offline-queue replay later | 2 s / 10 s | offline queue |
| `stats` / `graph` / `timeline` / `gates` / `evolve` / `share*` / `import*` | `null` → command renders empty | 1–15 s | none |
| `search` / `routeTask` / `user` / `brainProxy` / `pilContext` | `null` → caller falls back | 1–3 s | none |
| `fetchBBContext` (BB-aware `/ideal`) | Empty `BBContext` | ≤ `timeoutMs` (default `BB_RETRIEVAL_TIMEOUT_MS`) | none — single retry handled by `queryWithRetry` |
| `layer3EeInjection` | Layer marked `applied:false`, no MANDATORY RULES block | ≤ `PIL_SEARCH_TIMEOUT_MS` (1500 ms) | none |

## How to detect EE is down

- **Stderr (rate-limited)**:
  - `[muonroi-cli] EE unreachable (<reason>); intercept short-circuiting to allow.`
    — emitted at most once every 60 s by `client.intercept`.
  - `[muonroi-cli] EE circuit breaker OPEN after N consecutive failures. Skipping intercept calls for 30s.`
    — emitted exactly when the breaker opens.
  - `[ee.bb] network error fetching BB context: <err>` — once per process from `fetchBBContext`.
  - `[ee.bb] no recipe hits — running Phase 3 ingestion would help` — once per process.
- **In-app**:
  - `/doctor` exposes EE health, circuit state, recent error stats. Use this
    first when warnings stop firing.
  - `usage stats` / `usage forensics <id>` reflect `null` EE responses as
    missing sections.
- **Programmatic**: `client.health()` returns `{ ok, status }` with `status: 0`
  on network-level failure.
- **Debug flags**:
  - `--debug-ee` CLI flag — enables verbose `[ee.bb]` telemetry on every BB retrieval.
  - `MUONROI_EE_DEBUG=1` — additional EE debug stderr from the boot path
    (see `src/index.ts`).

## How to disable EE entirely

There is no master kill-switch — every call site degrades on its own. The
practical levers are:

- **BB-aware `/ideal` context**: set `userSettings.eeBBContext: false` in
  `~/.muonroi/settings.json`. `fetchBBContext` short-circuits to `empty`.
- **PIL Layer 3 effective disable**: there is no flag, but you can make the
  layer a no-op by lowering recall via `MUONROI_PIL_SCORE_FLOOR=1.0` (every
  hit gets filtered as noise). To force the formatter-only path, leave
  `MUONROI_PIL_UNIFIED=1` and clear `_brainData` upstream.
- **Point the client at a non-existent base**: set the `serverBaseUrl` in
  `~/.experience/config.json` to e.g. `http://127.0.0.1:1` — every call
  fails open within ≤ 100 ms. The circuit breaker will quickly stop even
  the 100 ms attempts.
- **Remove auth token**: delete `serverAuthToken` from `~/.experience/config.json`.
  All HTTP calls return 401 → fail open → retry-with-refresh → fail open
  again. Intercept latency stays bounded by the timeout.

Air-gapped / offline runs: the CLI is fully functional with the above
settings. Telemetry queued via `offline-queue` will replay automatically
once EE becomes reachable again.

## See also

- `docs/agent-harness/EE-INGESTION.md` — how the EE collections are seeded.
- `CLAUDE.md` § *BB-aware `/ideal`* — feature flag + injection markers.
- `src/ee/offline-queue.ts` — queue replay semantics.
