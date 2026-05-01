# Phase 09: Offline Queue - Research

**Researched:** 2026-05-02
**Domain:** Node.js file-system queue + circuit breaker integration (TypeScript, ESM)
**Confidence:** HIGH

## Summary

Phase 09 adds a transparent offline buffer so no EE write operations are lost when the EE server
is temporarily unreachable. All decisions are locked in CONTEXT.md: one JSON file per entry in
`~/.muonroi-cli/ee-offline-queue/`, timestamp-based filenames for natural FIFO, cap of 100 with
oldest-drop enforcement, and replay triggered by `recordCircuitSuccess()` in `src/ee/client.ts`.

The implementation is a single new file `src/ee/offline-queue.ts` that exposes `enqueue()` and
`drainQueue()`. The existing EE client's `feedback()`, `extract()`, and `promptStale()` methods
get `enqueue()` calls in their catch/failure paths. `recordCircuitSuccess()` gets a single
`drainQueue()` call added. No extra timers, no background sweeps, no complex retry scheduling.

**Primary recommendation:** Use `node:fs/promises` for all queue I/O (non-blocking, consistent with
the rest of the codebase pattern in `src/ee/auth.ts`). Keep queue module pure — no imports from
`intercept.ts` to avoid circular deps. Accept the fetch implementation as a parameter for testability.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** One JSON file per queue entry in `~/.muonroi-cli/ee-offline-queue/`. Atomic writes, easy to enumerate and delete.
- **D-02:** Timestamp-based filenames (`{Date.now()}-{random4}.json`) for natural FIFO ordering with no collisions.
- **D-03:** Each entry stores: original request body, endpoint path, and enqueue timestamp.
- **D-04:** Cap enforcement on enqueue: if count >= 100, delete oldest file before writing new one. Simple FIFO, no background sweep.
- **D-05:** Replay triggers on circuit breaker half-open probe success — piggyback on `recordCircuitSuccess()`.
- **D-06:** Sequential replay, one entry at a time. Prevents flooding a just-recovered EE server.
- **D-07:** If replay of an entry fails, leave it in queue and re-close the circuit. No infinite retry loop.
- **D-08:** Replay runs in background async (fire-and-forget). Never blocks CLI hot path.
- **D-09:** New `src/ee/offline-queue.ts` module. Client calls `enqueue()` on failure, `drainQueue()` on circuit recovery.
- **D-10:** Only write operations get queued: feedback, extract, prompt-stale. Intercept (read) already short-circuits — no value in queuing.
- **D-11:** Lazy init on first enqueue — create queue directory only when needed.
- **D-12:** Hook into `recordCircuitSuccess()` in client.ts to trigger `drainQueue()`.

### Claude's Discretion

- Internal error handling for filesystem operations (mkdir, readdir, writeFile, unlink)
- Whether to use `fs/promises` or synchronous fs for queue operations
- Test structure and mocking approach for the offline queue module
- Whether to add a debug log on enqueue/dequeue for developer troubleshooting

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QUEUE-01 | EE client buffers failed requests to local queue when server unreachable | `enqueue()` called in catch blocks of `feedback()`, `extract()`, `promptStale()` in client.ts |
| QUEUE-02 | Queue persists on disk (`~/.muonroi-cli/ee-offline-queue/`) | `node:fs/promises` + `os.homedir()` path construction, survives process restart |
| QUEUE-03 | Queue replays automatically when EE server becomes reachable again | `drainQueue()` hooked into `recordCircuitSuccess()` as fire-and-forget |
| QUEUE-04 | Queue has max size cap (100 entries) to prevent unbounded growth | Cap check on enqueue: `readdir` count >= 100 → delete oldest before write |
| QUEUE-05 | Heavy events (extract) drain separately in background | `drainQueue()` is async fire-and-forget, sequential replay, never awaited by caller |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:fs/promises` | Built-in (Node >=20) | Async file I/O for queue entries | Non-blocking, consistent with `auth.ts` pattern in codebase |
| `node:os` | Built-in | `os.homedir()` for queue dir path | Already used in `auth.ts` and `bridge.ts` |
| `node:path` | Built-in | Cross-platform path joins | Already used everywhere in codebase |
| `node:crypto` | Built-in | 4-char random suffix for filenames | Prevents collision on sub-millisecond enqueues |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | 4.1.5 (project) | Unit tests for queue module | All tests in this phase |
| `node:http` (via ee-server stub) | Built-in | Integration test with stub EE | Already available in `src/__test-stubs__/ee-server.ts` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:fs/promises` | `node:fs` (sync) | Sync blocks event loop on enqueue — bad for CLI hot path; async preferred |
| `node:crypto.randomBytes` | `Math.random()` | Math.random sufficient for 4-char suffix given ms-resolution timestamps; crypto is overkill but acceptable |
| `proper-lockfile` (already dep) | No lock on queue dir | Multiple fast enqueues in same ms could race; timestamp+random4 suffix is simpler and sufficient given single-process CLI |

**Installation:** No new packages needed. All dependencies are Node built-ins or already in the project.

## Architecture Patterns

### Recommended Project Structure

```
src/ee/
├── client.ts           # Circuit breaker — add drainQueue() call in recordCircuitSuccess()
├── offline-queue.ts    # NEW: enqueue(), drainQueue(), getQueueDir()
├── offline-queue.test.ts  # NEW: unit tests (mocked fs) + integration tests
└── types.ts            # Existing types — QueueEntry type added here or inline
```

### Pattern 1: Queue Entry Shape

Each file on disk is a JSON object with exactly what the replayer needs to re-issue the HTTP call:

```typescript
// Source: CONTEXT.md D-03
interface QueueEntry {
  endpoint: string;       // e.g. "/api/feedback", "/api/extract", "/api/prompt-stale"
  body: unknown;          // original request payload verbatim
  enqueuedAt: number;     // Date.now() at enqueue time
}
```

### Pattern 2: Filename Convention

```typescript
// Source: CONTEXT.md D-02
function makeFilename(): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).slice(2, 6); // 4 chars
  return `${ts}-${rnd}.json`;
}
```

FIFO ordering is natural because `readdir` + `sort()` on timestamp-prefixed names gives chronological order.

### Pattern 3: Enqueue with Cap

```typescript
// Source: CONTEXT.md D-04, D-11
export async function enqueue(entry: QueueEntry): Promise<void> {
  const dir = getQueueDir();
  await fs.mkdir(dir, { recursive: true }); // D-11: lazy init

  const files = await getSortedFiles(dir);  // readdir + sort
  if (files.length >= MAX_QUEUE_SIZE) {
    // D-04: drop oldest before writing new
    await fs.unlink(path.join(dir, files[0])).catch(() => {});
  }

  const filename = makeFilename();
  const data = JSON.stringify(entry);
  await fs.writeFile(path.join(dir, filename), data, "utf8");
}
```

### Pattern 4: Sequential Drain (fire-and-forget)

```typescript
// Source: CONTEXT.md D-05, D-06, D-07, D-08
export function drainQueue(fetchImpl: typeof fetch, headers: Record<string, string>, baseUrl: string): void {
  // Fire-and-forget — never awaited by caller
  void (async () => {
    const dir = getQueueDir();
    let files: string[];
    try {
      files = await getSortedFiles(dir);
    } catch {
      return; // queue dir doesn't exist yet — nothing to drain
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      let entry: QueueEntry;
      try {
        const raw = await fs.readFile(filePath, "utf8");
        entry = JSON.parse(raw) as QueueEntry;
      } catch {
        // Corrupt entry — discard silently
        await fs.unlink(filePath).catch(() => {});
        continue;
      }

      try {
        const resp = await fetchImpl(`${baseUrl}${entry.endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify(entry.body),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          await fs.unlink(filePath).catch(() => {});
        } else {
          // D-07: server returned error — leave entry, stop drain
          break;
        }
      } catch {
        // D-07: network failure — leave entry, stop drain
        break;
      }
    }
  })();
}
```

### Pattern 5: Integration into client.ts

```typescript
// In recordCircuitSuccess() — D-12
function recordCircuitSuccess(): void {
  _circuitState = "closed";
  _consecutiveFailures = 0;
  // Trigger offline queue drain on EE recovery
  drainQueue(f, headers(), baseUrl); // fire-and-forget
}
```

```typescript
// In feedback() — D-10, QUEUE-01
feedback(payload: FeedbackPayload): void {
  f(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  }).catch(() => {
    void enqueue({ endpoint: "/api/feedback", body: payload, enqueuedAt: Date.now() });
  });
},
```

```typescript
// In extract() — D-10, QUEUE-01
async extract(req: ExtractRequest, signal?: AbortSignal): Promise<ExtractResponse | null> {
  try {
    const resp = await f(`${baseUrl}/api/extract`, { ... });
    if (!resp.ok) {
      void enqueue({ endpoint: "/api/extract", body: req, enqueuedAt: Date.now() });
      return null;
    }
    return (await resp.json()) as ExtractResponse;
  } catch {
    void enqueue({ endpoint: "/api/extract", body: req, enqueuedAt: Date.now() });
    return null;
  }
},
```

### Anti-Patterns to Avoid

- **Awaiting drainQueue() in recordCircuitSuccess():** Makes the circuit recovery path blocking. Always fire-and-forget.
- **Using synchronous fs in enqueue():** Blocks the Node event loop on disk I/O. Use `fs/promises`.
- **Storing AbortSignal in queue entries:** Signals are transient — they cannot be serialized. Replay uses a fresh `AbortSignal.timeout(5000)`.
- **Recursive drain on replay failure:** If replay fails, break the loop and let the next `recordCircuitSuccess()` trigger another drain cycle. Do not re-open the circuit from drain logic.
- **Importing from intercept.ts in offline-queue.ts:** Creates circular dependency chain (`intercept.ts` → `client.ts` → `offline-queue.ts` → `intercept.ts`). Keep `offline-queue.ts` pure — accept fetch/headers/baseUrl as parameters.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| FIFO ordering | Custom priority queue | Timestamp-prefixed filenames + sort | Natural order, no in-memory state needed |
| Collision avoidance | UUID library | `Date.now() + Math.random().toString(36).slice(2,6)` | Sufficient for single-process CLI; no extra dep |
| Atomic writes | Custom lock mechanism | `fs.writeFile()` on new unique file | Each write is a new file — no partial-write race |
| Retry scheduling | Exponential backoff library | Circuit breaker half-open cycle (already 30s) | Piggybacks on existing infrastructure |

**Key insight:** The circuit breaker already provides all the timing/retry logic needed. The queue is purely a persistence layer — it stores payloads when the breaker is open and replays when the breaker closes. No separate scheduler needed.

## Common Pitfalls

### Pitfall 1: drainQueue() Called Before Directory Exists

**What goes wrong:** `drainQueue()` is called on `recordCircuitSuccess()` but the queue directory was never created (EE was reachable on first use). `readdir` throws `ENOENT`.

**Why it happens:** Lazy init (D-11) only creates the directory on `enqueue()`. If EE never went down, the directory never exists.

**How to avoid:** Wrap `readdir` in try/catch in `drainQueue()` and return early on `ENOENT`. This is the normal "nothing to drain" path.

**Warning signs:** `ENOENT` errors in drain logic on fresh installs.

---

### Pitfall 2: drainQueue() Re-enqueues Failed Replays

**What goes wrong:** A replay attempt fails. The entry is `enqueue()`'d again (e.g., as a reflex from the catch block). The queue grows without bound.

**Why it happens:** Reusing `enqueue()` in drain's catch block.

**How to avoid:** Drain has its own failure handling — break the loop, leave the file on disk. Never call `enqueue()` from within `drainQueue()`.

**Warning signs:** Queue grows past 100 entries despite cap — indicates entries are being re-added.

---

### Pitfall 3: Circular Import Between offline-queue.ts and client.ts

**What goes wrong:** `offline-queue.ts` imports `getDefaultEEClient()` from `intercept.ts`; `intercept.ts` imports from `client.ts`; `client.ts` imports `drainQueue` from `offline-queue.ts`. Circular.

**Why it happens:** Trying to make `drainQueue()` use the existing EE client instance.

**How to avoid:** `drainQueue()` must accept `fetchImpl`, `headers`, and `baseUrl` as parameters — not import from client or intercept. `client.ts` passes these down when calling `drainQueue()`.

**Warning signs:** Node ESM circular dependency warning at startup; functions appear `undefined` at call time.

---

### Pitfall 4: Cap Check Races on Sub-Millisecond Enqueues

**What goes wrong:** Two `enqueue()` calls at the same millisecond both read 99 files, both skip the delete step, both write — queue has 101 entries.

**Why it happens:** Cap enforcement is `readdir → if >=100 → delete → write`, non-atomic.

**How to avoid:** The CLI is single-process; true concurrent enqueues in the same millisecond are astronomically rare. The 4-char random suffix prevents filename collision. Accept minor over-count (101 vs 100) as acceptable drift — no locking needed.

**Warning signs:** Queue has exactly 101 entries — indicates a sub-ms race occurred. Acceptable edge case per design.

---

### Pitfall 5: Serialized AbortSignal Causes Replay Failures

**What goes wrong:** `AbortSignal` stored in the queue entry JSON comes back as `{}` after JSON parse. Replay uses a dead/empty signal object.

**Why it happens:** `AbortSignal` is not JSON-serializable.

**How to avoid:** Never store `AbortSignal` in queue entries. Replay always creates a fresh `AbortSignal.timeout(5000)` for each replayed request.

**Warning signs:** Replay requests immediately timeout or behave erratically.

---

### Pitfall 6: Intercept Calls Getting Queued

**What goes wrong:** `intercept()` failures enqueue a read request. On replay, EE gets called for a stale intercept decision that no longer applies.

**Why it happens:** Generic "queue on failure" logic applied to all EE methods.

**How to avoid:** Per D-10, only `feedback`, `extract`, and `promptStale` are queued. `intercept()` short-circuits to `allow` on failure — no queue entry.

**Warning signs:** Queue entries with endpoint `/api/intercept`.

## Code Examples

### getQueueDir() — path construction

```typescript
// Consistent with auth.ts pattern (os.homedir() + path.join)
import * as os from "node:os";
import * as path from "node:path";

const QUEUE_DIR_NAME = "ee-offline-queue";

export function getQueueDir(homeOverride?: string): string {
  return path.join(homeOverride ?? os.homedir(), ".muonroi-cli", QUEUE_DIR_NAME);
}
```

### getSortedFiles() — FIFO enumeration

```typescript
import { promises as fs } from "node:fs";

async function getSortedFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  // Filter to only .json files, sort by timestamp prefix (natural FIFO)
  return entries
    .filter((f) => f.endsWith(".json"))
    .sort(); // lexicographic = chronological given timestamp prefix
}
```

### Test structure — mocked fs

```typescript
// Pattern: inject homeOverride to avoid touching real ~/.muonroi-cli in tests
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "queue-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

it("enqueue writes a file to the queue dir", async () => {
  await enqueue({ endpoint: "/api/feedback", body: { test: 1 }, enqueuedAt: 1000 }, tmpDir);
  const files = await readdir(path.join(tmpDir, ".muonroi-cli", "ee-offline-queue"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d+-[a-z0-9]{4}\.json$/);
});
```

### Test structure — drain integration with stub server

```typescript
// Reuse existing startStubEEServer from src/__test-stubs__/ee-server.ts
import { startStubEEServer } from "../__test-stubs__/ee-server.js";

it("drainQueue replays feedback entry when server recovers", async () => {
  const stub = await startStubEEServer({ feedback: () => {} });
  // Pre-populate queue
  await enqueue({ endpoint: "/api/feedback", body: { principle_uuid: "x" }, enqueuedAt: Date.now() }, tmpDir);
  // Drain
  await drainQueueAsync(fetch, { "Content-Type": "application/json" }, `http://127.0.0.1:${stub.port}`, tmpDir);
  expect(stub.calls.feedback).toHaveLength(1);
  await stub.stop();
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-memory queue (lost on restart) | Disk-based JSON files | This phase | Queue survives CLI restart per QUEUE-02 |
| No recovery from EE downtime | Circuit breaker + offline queue | This phase | Zero data loss on transient outage |

**Deprecated/outdated:**

- None applicable to this phase (greenfield queue module).

## Open Questions

1. **Should `drainQueue` accept `homeOverride` for testability?**
   - What we know: Tests use `tmpDir` injection to avoid touching real home directory (established pattern in `auth.ts` tests).
   - What's unclear: Whether to thread `homeOverride` through `drainQueue()` or resolve it at construction time.
   - Recommendation: Accept `homeOverride` as optional last parameter on both `enqueue()` and `drainQueue()`. Consistent with `auth.ts` approach.

2. **Debug logging on enqueue/dequeue?**
   - What we know: Claude's Discretion per CONTEXT.md.
   - What's unclear: Whether `console.debug` adds value or becomes noise.
   - Recommendation: Add `console.debug("[muonroi-cli] EE offline queue: enqueued %s (%d entries)", endpoint, count)` gated behind an environment variable check (`process.env.MUONROI_DEBUG`). Zero cost when unset.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — all required APIs are Node.js built-ins already available in the project runtime: `node:fs/promises`, `node:os`, `node:path`).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `bunx vitest run src/ee/offline-queue.test.ts` |
| Full suite command | `bunx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| QUEUE-01 | `enqueue()` called when EE returns error/throws | unit | `bunx vitest run src/ee/offline-queue.test.ts` | ❌ Wave 0 |
| QUEUE-02 | Queue files survive across process restarts (files persist on disk in tmpDir) | unit | `bunx vitest run src/ee/offline-queue.test.ts` | ❌ Wave 0 |
| QUEUE-03 | `drainQueue()` replays entries when stub server is up | integration | `bunx vitest run src/ee/offline-queue.test.ts` | ❌ Wave 0 |
| QUEUE-04 | Enqueue with 100 entries: oldest deleted, new written, count stays at 100 | unit | `bunx vitest run src/ee/offline-queue.test.ts` | ❌ Wave 0 |
| QUEUE-05 | `drainQueue()` called without await — does not block caller | unit | `bunx vitest run src/ee/offline-queue.test.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `bunx vitest run src/ee/offline-queue.test.ts`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/ee/offline-queue.ts` — implementation module (new file)
- [ ] `src/ee/offline-queue.test.ts` — covers QUEUE-01 through QUEUE-05

## Project Constraints (from CLAUDE.md)

| Directive | Impact on Phase |
|-----------|----------------|
| MCP tools over shell commands | Research only — implementation uses Node built-ins, not shell |
| GSD skill for non-trivial tasks | This phase uses GSD pipeline |
| Reply in Vietnamese; code/comments in English | All code comments in English |
| Read `REPO_DEEP_MAP.md` before working in repo | Planner should read before execution |
| Update `REPO_DEEP_MAP.md` when adding key files | Add `offline-queue.ts` entry when complete |
| Experience Engine hooks: follow high-confidence warnings | Executor must follow hook guidance |

## Sources

### Primary (HIGH confidence)

- `src/ee/client.ts` — full circuit breaker implementation, all EE methods, module-level state pattern
- `src/ee/auth.ts` — `os.homedir()` path pattern, `fs.promises` usage, `homeOverride` test injection pattern
- `src/ee/types.ts` — `FeedbackPayload`, `ExtractRequest`, `PromptStaleRequest` shapes for queue entries
- `src/ee/extract-session.ts` — fire-and-forget pattern, AbortSignal.timeout usage
- `src/__test-stubs__/ee-server.ts` — existing stub server reusable for integration tests
- `src/ee/extract-session.test.ts` — established test patterns (tmpDir injection, vi.fn mocks, stub server usage)
- `.planning/phases/09-offline-queue/09-CONTEXT.md` — all locked decisions (D-01 through D-12)
- `package.json` — vitest 4.1.5, bun test runner, Node >=20 requirement confirmed

### Secondary (MEDIUM confidence)

- Node.js v20 docs: `fs/promises` API is stable, `readdir()` returns string[], `mkdir({ recursive: true })` is idempotent
- `AbortSignal.timeout()` available in Node >=17.3 — covered by project's Node >=20 engine requirement

### Tertiary (LOW confidence)

- None — all critical claims verified from in-repo source or Node built-in documentation.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all dependencies are Node built-ins already in use in project
- Architecture: HIGH — patterns derived directly from locked CONTEXT.md decisions and existing codebase patterns
- Pitfalls: HIGH — derived from code analysis of the specific integration points in client.ts and intercept.ts

**Research date:** 2026-05-02
**Valid until:** 2026-06-02 (stable domain — no third-party dependencies)
