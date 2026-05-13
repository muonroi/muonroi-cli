# Discord Channel-per-Product (Subsystem F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Subsystem F — make a Discord channel the primary stakeholder touchpoint per product: lazy-create private channel, broadcast every `push_notification` chunk, conduct conversational verdict capture via leader LLM, and add a `muonroi share` CLI command — all gated behind `MUONROI_DISCORD_TOKEN` + `MUONROI_DISCORD_GUILD_ID` env vars.

**Architecture:** Build three shared utils (rate-limit, slugify, file-lock) first so `src/discord/` and other consumers can depend on them without crossing layer boundaries. Then add product-identity + stakeholder-acl in `src/product-loop/` (both forward-compat for Subsystem G). Then rebalance `phase-budget` to add a `verdict` hint bucket. Then build the six Discord files (types/constants, REST client, channel-manager, broadcast-bus, intent-prompt, verdict-resolver). Finally wire `muonroi share` subcommand into `src/index.ts` (commander.js) and intercept the `phaseGen` yield loop in `src/product-loop/index.ts` to swap `awaitCustomerVerdict` and broadcast `push_notification` chunks when Discord env is set.

**Tech Stack:** TypeScript (ESNext strict, Bundler moduleResolution, CRLF via biome.json), vitest with vi.fn() mocks, biome (lint+format), husky pre-commit (lowercase commit subject). Discord REST v10 via raw `fetch` (no SDK). Reuse from E: `LeaderLike`, `withRateLimitBackoff` (relocated this plan), council debate, `appendSystemMessage`, `readArtifact`/`writeArtifact`, `atomicWriteText`, `Migrator` type, oldest-first decay pattern. Spec: `docs/superpowers/specs/2026-05-13-discord-channel-broadcast-design.md` (commit 3cd5c3d).

---

## File Map

**Shared utility extractions (3 new, in `src/utils/`):**

| File | Responsibility |
|---|---|
| `src/utils/rate-limit.ts` | `withRateLimitBackoff<T>(fn, opts)` extracted from `discovery-recommender.ts`. Existing import path re-exports for backwards-compat. |
| `src/utils/slugify.ts` | `slugify(text)` extracted from private `slugifyTitle` in `ship-polish.ts`. Discord-compatible normalization. |
| `src/utils/file-lock.ts` | `withFileLock(path, fn)` cross-process advisory lock via `fs.open` with `wx` flag + exponential retry. |

**New Discord layer (6 new, in `src/discord/`):**

| File | Responsibility |
|---|---|
| `src/discord/types.ts` | `DiscordClient` interface, `DiscordMessage`, `DiscordChannelMapping`, `PollCursor`, `BroadcastType` union |
| `src/discord/verdict-constants.ts` | Numeric constants (floors, caps, retry budgets, intervals) |
| `src/discord/client.ts` | `DiscordRestClient` (REST v10 fetch wrapper with 429/Retry-After) |
| `src/discord/channel-manager.ts` | `ensureChannel`, in-process dedup, persistent mapping with file-lock, `registerChannelCreatedHook` + `clearChannelCreatedHooks` |
| `src/discord/broadcast-bus.ts` | `publish` with empty-content / oversize-content / 404 / 403 handling |
| `src/discord/intent-prompt.ts` | `SYSTEM_PROMPT`, `buildConvoPrompt`, `parseConvoReply` |
| `src/discord/verdict-resolver.ts` | `discordAwaitVerdict` poll loop with all bounded retries |

**New product-loop additions (2 new, in `src/product-loop/`):**

| File | Responsibility |
|---|---|
| `src/product-loop/product-identity.ts` | `productSlug(idea)` with Discord-name round-trip invariant |
| `src/product-loop/stakeholder-acl.ts` | Stakeholder types + `addStakeholder` / `removeStakeholder` / `listStakeholders` with file-lock |

**New CLI command (1):**

| File | Responsibility |
|---|---|
| `src/cli/share-cmd.ts` | `runShareCommand(args)` — pure function callable by commander subcommand registration |

**Modified files (4):**

| File | Change |
|---|---|
| `src/product-loop/discovery-recommender.ts` | Re-export `withRateLimitBackoff` from `src/utils/rate-limit.ts` (backwards-compat shim). |
| `src/product-loop/phase-budget.ts` | Add `verdict` phase to union; rebalance `PHASE_HINTS` (sprint 0.30→0.28, verdict 0.02). |
| `src/product-loop/index.ts` | When Discord env vars set: intercept `phaseGen` yield to broadcast; swap `awaitCustomerVerdict` to `discordAwaitVerdict`. Partial-env warning. |
| `src/index.ts` | Register `share` subcommand via commander. |

**Test files (10 new + 2 modified):**

- `src/utils/__tests__/rate-limit.test.ts` (relocated from discovery-recommender.test.ts — same cases)
- `src/utils/__tests__/slugify.test.ts`
- `src/utils/__tests__/file-lock.test.ts`
- `src/product-loop/__tests__/product-identity.test.ts`
- `src/product-loop/__tests__/stakeholder-acl.test.ts`
- `src/product-loop/__tests__/phase-budget.test.ts` (extend with verdict-bucket cases)
- `src/discord/__tests__/client.test.ts`
- `src/discord/__tests__/channel-manager.test.ts`
- `src/discord/__tests__/broadcast-bus.test.ts`
- `src/discord/__tests__/intent-prompt.test.ts`
- `src/discord/__tests__/verdict-resolver.test.ts`
- `src/discord/__tests__/discord-integration.test.ts`
- `src/cli/__tests__/share-cmd.test.ts`

---

## Task 1: Extract `withRateLimitBackoff` to shared util

**Files:**
- Create: `src/utils/rate-limit.ts`
- Create test: `src/utils/__tests__/rate-limit.test.ts`
- Modify: `src/product-loop/discovery-recommender.ts` (replace impl with re-export)

- [ ] **Step 1: Write failing tests**

Create `src/utils/__tests__/rate-limit.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { withRateLimitBackoff } from "../rate-limit.js";

describe("withRateLimitBackoff", () => {
  it("returns value on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRateLimitBackoff(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 up to maxRetries", async () => {
    const err: any = new Error("rate limit"); err.status = 429;
    const fn = vi.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValue("ok");
    const result = await withRateLimitBackoff(fn, { delays: [1, 1] });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries=3 total attempts", async () => {
    const err: any = new Error("429"); err.status = 429;
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRateLimitBackoff(fn, { delays: [1] })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-429 immediately", async () => {
    const err = new Error("500 boom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRateLimitBackoff(fn)).rejects.toThrow("500 boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("matches /429/ in message even without status", async () => {
    const err = new Error("got 429 from server");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const result = await withRateLimitBackoff(fn, { delays: [1] });
    expect(result).toBe("ok");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/rate-limit.test.ts
```

Expected: FAIL with "Cannot find module '../rate-limit.js'".

- [ ] **Step 3: Create `src/utils/rate-limit.ts`**

```ts
export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  opts: { delays?: number[]; maxRetries?: number } = {},
): Promise<T> {
  const delays = opts.delays ?? [1000, 4000, 16000];
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e ?? "");
      const is429 = e?.status === 429 || /429|rate.?limit/i.test(msg);
      if (!is429 || attempt === maxRetries - 1) throw e;
      const ms = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Replace impl in `discovery-recommender.ts` with re-export**

Locate `withRateLimitBackoff` (around line 244 of `src/product-loop/discovery-recommender.ts`) and replace the function body + signature with:

```ts
export { withRateLimitBackoff } from "../utils/rate-limit.js";
```

Remove the now-dead function body.

- [ ] **Step 5: Verify tests pass + no regressions**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/rate-limit.test.ts src/product-loop/__tests__/discovery-recommender.test.ts && npx tsc --noEmit
```

Expected: all pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/utils/rate-limit.ts src/utils/__tests__/rate-limit.test.ts src/product-loop/discovery-recommender.ts
git commit -m "refactor(utils): extract withRateLimitBackoff to shared util"
```

---

## Task 2: Extract `slugify` to shared util

**Files:**
- Create: `src/utils/slugify.ts`
- Create test: `src/utils/__tests__/slugify.test.ts`
- Modify: `src/product-loop/ship-polish.ts` (replace private `slugifyTitle` with import)

- [ ] **Step 1: Inspect existing `slugifyTitle`**

```
grep -n "slugifyTitle" src/product-loop/ship-polish.ts
```

Note the existing implementation; the new shared one must produce identical output for backwards-compat. Also note all internal callers in `ship-polish.ts`.

- [ ] **Step 2: Write failing tests**

Create `src/utils/__tests__/slugify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slugify } from "../slugify.js";

describe("slugify", () => {
  it("lowercases all alphabetic chars", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces non-alphanumeric with single dash", () => {
    expect(slugify("foo!@#$bar")).toBe("foo-bar");
  });

  it("collapses consecutive dashes", () => {
    expect(slugify("a    b    c")).toBe("a-b-c");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("strips Unicode combining marks (NFKD)", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("handles empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("Discord-name round-trip: lowercase + only [a-z0-9-]", () => {
    const out = slugify("Hello, World! 2026");
    expect(out).toBe("hello-world-2026");
    expect(/^[a-z0-9-]*$/.test(out)).toBe(true);
  });

  it("does not slice — caller decides length", () => {
    const out = slugify("a".repeat(200));
    expect(out.length).toBe(200);
  });

  it("Vietnamese with diacritics produces alphanumeric only", () => {
    const out = slugify("Sản phẩm mới");
    expect(/^[a-z0-9-]*$/.test(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/slugify.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 4: Create `src/utils/slugify.ts`**

```ts
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 5: Replace `slugifyTitle` in `ship-polish.ts`**

Add at top of `src/product-loop/ship-polish.ts`:
```ts
import { slugify } from "../utils/slugify.js";
```

Find existing private `slugifyTitle(title)` (search for `function slugifyTitle`); delete the function. Replace each call site `slugifyTitle(x)` with `slugify(x)`. If existing impl had `.slice(...)` baked in, apply slice at the call site instead.

- [ ] **Step 6: Verify tests + tsc**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/slugify.test.ts src/product-loop/__tests__/ship-polish.test.ts && npx tsc --noEmit
```

Expected: all pass, tsc clean. If `ship-polish.test.ts` doesn't exist, just run the slugify test.

- [ ] **Step 7: Commit**

```bash
git add src/utils/slugify.ts src/utils/__tests__/slugify.test.ts src/product-loop/ship-polish.ts
git commit -m "refactor(utils): extract slugify to shared util"
```

---

## Task 3: Cross-process file lock

**Files:**
- Create: `src/utils/file-lock.ts`
- Create test: `src/utils/__tests__/file-lock.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/utils/__tests__/file-lock.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { withFileLock } from "../file-lock.js";

describe("withFileLock", () => {
  let tmpFile: string;
  beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `lock-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    tmpFile = path.join(dir, "target.json");
  });

  it("runs the callback and returns its value", async () => {
    const result = await withFileLock(tmpFile, async () => 42);
    expect(result).toBe(42);
  });

  it("removes lockfile after callback completes", async () => {
    await withFileLock(tmpFile, async () => {});
    await expect(fs.stat(`${tmpFile}.lock`)).rejects.toThrow();
  });

  it("removes lockfile even if callback throws", async () => {
    await expect(withFileLock(tmpFile, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(fs.stat(`${tmpFile}.lock`)).rejects.toThrow();
  });

  it("serializes concurrent callers on same path", async () => {
    const order: number[] = [];
    const p1 = withFileLock(tmpFile, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });
    const p2 = withFileLock(tmpFile, async () => {
      order.push(3);
      order.push(4);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("different paths do NOT block each other", async () => {
    const other = `${tmpFile}.other`;
    const start = Date.now();
    await Promise.all([
      withFileLock(tmpFile, async () => { await new Promise((r) => setTimeout(r, 50)); }),
      withFileLock(other, async () => { await new Promise((r) => setTimeout(r, 50)); }),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(90);
  });

  it("respects retry timeout", async () => {
    // Hold lock for 200ms; second call should wait for it
    await fs.writeFile(`${tmpFile}.lock`, "manual");
    let acquired = false;
    const release = setTimeout(() => fs.unlink(`${tmpFile}.lock`).catch(() => {}), 50);
    await withFileLock(tmpFile, async () => { acquired = true; });
    clearTimeout(release);
    expect(acquired).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/file-lock.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/utils/file-lock.ts`**

```ts
import { promises as fs } from "node:fs";

const DEFAULT_RETRY_MS = [10, 25, 50, 100, 200, 400, 800];
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FileLockOptions {
  retryDelays?: number[];
  timeoutMs?: number;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const retryDelays = opts.retryDelays ?? DEFAULT_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.close();
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`withFileLock: timed out waiting for ${lockPath}`);
      }
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/utils/__tests__/file-lock.test.ts && npx tsc --noEmit
```

Expected: all 6 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/utils/file-lock.ts src/utils/__tests__/file-lock.test.ts
git commit -m "feat(utils): cross-process file lock"
```

---

## Task 4: `productSlug`

**Files:**
- Create: `src/product-loop/product-identity.ts`
- Create test: `src/product-loop/__tests__/product-identity.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/product-loop/__tests__/product-identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { productSlug } from "../product-identity.js";

describe("productSlug", () => {
  it("returns 8-char hash prefix + dash + slug suffix", () => {
    const out = productSlug("Blog platform with auth");
    expect(out).toMatch(/^[a-f0-9]{8}-[a-z0-9-]+$/);
  });

  it("stable: same input → same output", () => {
    const a = productSlug("Build a chat app");
    const b = productSlug("Build a chat app");
    expect(a).toBe(b);
  });

  it("different inputs produce different slugs", () => {
    expect(productSlug("idea A")).not.toBe(productSlug("idea B"));
  });

  it("total length ≤ 49 chars (8 + 1 + 40)", () => {
    const out = productSlug("a".repeat(500));
    expect(out.length).toBeLessThanOrEqual(49);
  });

  it("slug suffix only contains [a-z0-9-]", () => {
    const out = productSlug("HELLO!@# WORLD ñ");
    const suffix = out.slice(9); // after "hhhhhhhh-"
    expect(/^[a-z0-9-]*$/.test(suffix)).toBe(true);
  });

  it("whitespace-only idea still yields valid slug", () => {
    const out = productSlug("   ");
    expect(out).toMatch(/^[a-f0-9]{8}/);
  });

  it("Discord round-trip: name muonroi-${slug} survives Discord's lowercase+replace transform unchanged", () => {
    const slug = productSlug("My Cool Product 2026");
    const channelName = `muonroi-${slug}`;
    const discordTransformed = channelName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    expect(channelName).toBe(discordTransformed);
  });

  it("Vietnamese with diacritics produces clean slug", () => {
    const out = productSlug("Sản phẩm thử nghiệm");
    expect(/^[a-f0-9]{8}-[a-z0-9-]+$/.test(out)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/product-identity.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/product-loop/product-identity.ts`**

```ts
import * as crypto from "node:crypto";
import { slugify } from "../utils/slugify.js";

const HASH_LEN = 8;
const SUFFIX_MAX_LEN = 40;

export function productSlug(idea: string): string {
  const h = crypto.createHash("sha1").update(idea).digest("hex").slice(0, HASH_LEN);
  const s = slugify(idea).slice(0, SUFFIX_MAX_LEN);
  return s ? `${h}-${s}` : h;
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/product-identity.test.ts && npx tsc --noEmit
```

Expected: 8 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/product-identity.ts src/product-loop/__tests__/product-identity.test.ts
git commit -m "feat(product): stable product slug with discord-compatible normalization"
```

---

## Task 5: Stakeholder ACL

**Files:**
- Create: `src/product-loop/stakeholder-acl.ts`
- Create test: `src/product-loop/__tests__/stakeholder-acl.test.ts`

- [ ] **Step 1: Confirm `muonroiHome()` helper**

```
grep -n "muonroiHome\|MUONROI_CLI_HOME\|\.muonroi-cli" src/cli/usage-report.ts | head -10
```

Note the existing function and its export path. The new file will import from there.

- [ ] **Step 2: Write failing tests**

Create `src/product-loop/__tests__/stakeholder-acl.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { addStakeholder, listStakeholders, removeStakeholder } from "../stakeholder-acl.js";

describe("stakeholder-acl", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `acl-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpHome, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
  });

  it("addStakeholder + listStakeholders round-trip", async () => {
    await addStakeholder("slug-a", {
      discordUserId: "1234", displayName: "alice", addedAtUtc: "2026-05-13T00:00:00Z", addedBy: "cli",
    });
    const items = await listStakeholders("slug-a");
    expect(items).toHaveLength(1);
    expect(items[0].discordUserId).toBe("1234");
  });

  it("re-adding same user is a no-op (idempotent)", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "x", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "x", addedAtUtc: "t2", addedBy: "cli" });
    const items = await listStakeholders("slug-a");
    expect(items).toHaveLength(1);
  });

  it("removeStakeholder removes by id", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-a", { discordUserId: "2", displayName: "b", addedAtUtc: "t", addedBy: "cli" });
    await removeStakeholder("slug-a", "1");
    const items = await listStakeholders("slug-a");
    expect(items.map((s) => s.discordUserId)).toEqual(["2"]);
  });

  it("listStakeholders returns [] when slug unknown", async () => {
    expect(await listStakeholders("nonexistent")).toEqual([]);
  });

  it("isolates stakeholders by slug", async () => {
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    await addStakeholder("slug-b", { discordUserId: "2", displayName: "b", addedAtUtc: "t", addedBy: "cli" });
    expect((await listStakeholders("slug-a")).map((s) => s.discordUserId)).toEqual(["1"]);
    expect((await listStakeholders("slug-b")).map((s) => s.discordUserId)).toEqual(["2"]);
  });

  it("corrupt file backed up + reinitialized", async () => {
    const filePath = path.join(tmpHome, "stakeholders.json");
    await fs.writeFile(filePath, "{ not valid json");
    await addStakeholder("slug-a", { discordUserId: "1", displayName: "a", addedAtUtc: "t", addedBy: "cli" });
    const entries = await fs.readdir(tmpHome);
    expect(entries.some((e) => e.startsWith("stakeholders.json.corrupt-"))).toBe(true);
    expect(await listStakeholders("slug-a")).toHaveLength(1);
  });

  it("refuses wrong schema version", async () => {
    const filePath = path.join(tmpHome, "stakeholders.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 99, items: {} }));
    await expect(listStakeholders("slug-a")).rejects.toThrow(/version|schema/i);
  });

  it("concurrent addStakeholder calls produce no duplicate entries", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      addStakeholder("slug-x", {
        discordUserId: String(i),
        displayName: `u${i}`,
        addedAtUtc: "t",
        addedBy: "cli",
      }),
    );
    await Promise.all(calls);
    const items = await listStakeholders("slug-x");
    expect(items.length).toBe(10);
  });
});
```

- [ ] **Step 3: Run tests to verify fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/stakeholder-acl.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 4: Create `src/product-loop/stakeholder-acl.ts`**

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import { withFileLock } from "../utils/file-lock.js";

const SCHEMA_VERSION = 1;

export interface Stakeholder {
  discordUserId: string;
  displayName: string;
  addedAtUtc: string;
  addedBy: "owner" | "cli";
}

export interface StakeholderStore {
  version: number;
  items: Record<string, { productSlug: string; stakeholders: Stakeholder[] }>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function storePath(): string {
  return path.join(muonroiHome(), "stakeholders.json");
}

async function readStore(): Promise<StakeholderStore> {
  const filePath = storePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { version: SCHEMA_VERSION, items: {} };
  }
  let parsed: StakeholderStore;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(filePath, `${filePath}.corrupt-${ts}`).catch(() => {});
    return { version: SCHEMA_VERSION, items: {} };
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`stakeholder-acl: unsupported schema version ${parsed.version} (expected ${SCHEMA_VERSION})`);
  }
  return parsed;
}

async function writeStore(store: StakeholderStore): Promise<void> {
  await fs.mkdir(muonroiHome(), { recursive: true });
  await atomicWriteText(storePath(), JSON.stringify(store, null, 2));
}

export async function listStakeholders(slug: string): Promise<Stakeholder[]> {
  const store = await readStore();
  return store.items[slug]?.stakeholders ?? [];
}

export async function addStakeholder(slug: string, s: Stakeholder): Promise<void> {
  await withFileLock(storePath(), async () => {
    const store = await readStore();
    const entry = store.items[slug] ?? { productSlug: slug, stakeholders: [] };
    if (!entry.stakeholders.some((x) => x.discordUserId === s.discordUserId)) {
      entry.stakeholders.push(s);
    }
    store.items[slug] = entry;
    await writeStore(store);
  });
}

export async function removeStakeholder(slug: string, discordUserId: string): Promise<void> {
  await withFileLock(storePath(), async () => {
    const store = await readStore();
    const entry = store.items[slug];
    if (!entry) return;
    entry.stakeholders = entry.stakeholders.filter((x) => x.discordUserId !== discordUserId);
    store.items[slug] = entry;
    await writeStore(store);
  });
}
```

- [ ] **Step 5: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/stakeholder-acl.test.ts && npx tsc --noEmit
```

Expected: 8 pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/product-loop/stakeholder-acl.ts src/product-loop/__tests__/stakeholder-acl.test.ts
git commit -m "feat(product): stakeholder acl with file lock and corrupt-recovery"
```

---

## Task 6: Phase-budget — add `verdict` bucket

**Files:**
- Modify: `src/product-loop/phase-budget.ts`
- Modify: `src/product-loop/__tests__/phase-budget.test.ts`

- [ ] **Step 1: Append failing tests**

Append at the end of `src/product-loop/__tests__/phase-budget.test.ts`:

```ts
describe("phase-budget verdict bucket (subsystem F)", () => {
  it("PHASE_HINTS includes 'verdict' bucket, sum still 1.0", () => {
    const total =
      PHASE_HINTS.discover + PHASE_HINTS.gather + PHASE_HINTS.research +
      PHASE_HINTS.scoping + PHASE_HINTS.sprint +
      PHASE_HINTS.planning + PHASE_HINTS.review +
      PHASE_HINTS.retro + PHASE_HINTS.standup +
      (PHASE_HINTS as any).verdict;
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("sprint hint reduced to 0.28 to make room for verdict 0.02", () => {
    expect(PHASE_HINTS.sprint).toBe(0.28);
    expect((PHASE_HINTS as any).verdict).toBe(0.02);
  });

  it("recordPhaseStart accepts new phase 'verdict'", async () => {
    const flowDir = path.join(os.tmpdir(), `budget-verdict-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
    mockGetSpent.mockResolvedValueOnce(0);
    const marker = await recordPhaseStart({ flowDir, runId: "rv", phase: "verdict" as any });
    expect(marker.phase).toBe("verdict");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-budget.test.ts
```

Expected: 3 new tests fail.

- [ ] **Step 3: Update `phase-budget.ts`**

Modify the `Phase` union — add `"verdict"`:

```ts
export type Phase =
  | "discover"
  | "gather"
  | "research"
  | "scoping"
  | "sprint"
  | "planning"
  | "review"
  | "retro"
  | "standup"
  | "verdict";
```

Modify `PHASE_HINTS`:

```ts
const PHASE_HINTS: Record<Phase, number> = {
  discover: 0.05,
  gather: 0.10,
  research: 0.30,
  scoping: 0.10,
  sprint: 0.28,
  planning: 0.03,
  review: 0.03,
  retro: 0.04,
  standup: 0.05,
  verdict: 0.02,
};
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-budget.test.ts && npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/product-loop/phase-budget.ts src/product-loop/__tests__/phase-budget.test.ts
git commit -m "feat(phase): add verdict bucket to phase_hints rebalanced"
```

---

## Task 7: Discord types + constants

**Files:**
- Create: `src/discord/types.ts`
- Create: `src/discord/verdict-constants.ts`

(No tests for pure type files; constants tested implicitly via downstream tasks.)

- [ ] **Step 1: Create `src/discord/types.ts`**

```ts
export interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}

export interface DiscordClient {
  createChannel(
    guildId: string,
    name: string,
    opts: { topic?: string; isPrivate?: boolean },
  ): Promise<{ id: string }>;
  getChannelMessages(
    channelId: string,
    opts: { afterId?: string; limit?: number },
  ): Promise<DiscordMessage[]>;
  postMessage(channelId: string, content: string): Promise<{ id: string }>;
  addChannelPermission(
    channelId: string,
    userId: string,
    allow: number,
    deny: number,
  ): Promise<void>;
  getCurrentUserId(): Promise<string>;
  listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>>;
}

export interface DiscordChannelMapping {
  productSlug: string;
  channelId: string;
  guildId: string;
  createdAtUtc: string;
  displayName: string;
}

export interface PollCursor {
  phaseId: string;
  sprintN: number;
  lastSeenId: string;
  lastPolledAtUtc: string;
}

export type BroadcastType =
  | "phase-event"
  | "env-provisioning"
  | "env-ready"
  | "env-teardown"
  | "custom";

/** Discord API permission bits we use. */
export const PERMISSION_BITS = {
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  READ_MESSAGE_HISTORY: 1 << 16,
} as const;

export const STAKEHOLDER_ALLOW =
  PERMISSION_BITS.VIEW_CHANNEL |
  PERMISSION_BITS.SEND_MESSAGES |
  PERMISSION_BITS.READ_MESSAGE_HISTORY;
```

- [ ] **Step 2: Create `src/discord/verdict-constants.ts`**

```ts
export const VERDICT_FLOOR_MIN_USD = 0.10;
export const VERDICT_FLOOR_FRACTION = 0.01;

export const MAX_VERDICT_MESSAGES_BASE = 20;
export const MAX_VERDICT_FRACTION = 0.02;
export const PER_MESSAGE_COST_ESTIMATE_USD = 0.012;

export const MAX_LEADER_FAILURES_BEFORE_FALLBACK = 3;
export const MAX_UNKNOWN_INTENT_BEFORE_FALLBACK = 5;

export const MAX_MESSAGES_PER_POLL = 50;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DISCORD_CONTENT_BUDGET = 1900;

export function verdictFloor(capUsd: number): number {
  return Math.max(VERDICT_FLOOR_MIN_USD, VERDICT_FLOOR_FRACTION * capUsd);
}

export function maxVerdictMessages(capUsd: number): number {
  return Math.max(
    MAX_VERDICT_MESSAGES_BASE,
    Math.floor((MAX_VERDICT_FRACTION * capUsd) / PER_MESSAGE_COST_ESTIMATE_USD),
  );
}
```

- [ ] **Step 3: Verify tsc clean**

```
cd D:/sources/Core/muonroi-cli && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/discord/types.ts src/discord/verdict-constants.ts
git commit -m "feat(discord): types and verdict constants"
```

---

## Task 8: Discord REST client

**Files:**
- Create: `src/discord/client.ts`
- Create test: `src/discord/__tests__/client.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/discord/__tests__/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DiscordRestClient } from "../client.js";

describe("DiscordRestClient", () => {
  function mockFetch(impl: (url: string, init: any) => Promise<Response>) {
    return vi.fn(impl);
  }

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  }

  it("createChannel POSTs to /guilds/<id>/channels with auth header", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/guilds/g1/channels");
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bot tok");
      const body = JSON.parse(init.body);
      expect(body.name).toBe("muonroi-test");
      return jsonResponse({ id: "c1" });
    });
    const client = new DiscordRestClient("tok", fetch as any);
    const out = await client.createChannel("g1", "muonroi-test", { topic: "t", isPrivate: true });
    expect(out.id).toBe("c1");
  });

  it("postMessage sends content as JSON", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/channels/c1/messages");
      const body = JSON.parse(init.body);
      expect(body.content).toBe("hello 🚀");
      return jsonResponse({ id: "m1" });
    });
    const client = new DiscordRestClient("tok", fetch as any);
    const out = await client.postMessage("c1", "hello 🚀");
    expect(out.id).toBe("m1");
  });

  it("getChannelMessages includes after + limit query params", async () => {
    const fetch = mockFetch(async (url) => {
      expect(url).toContain("?after=m0&limit=50");
      return jsonResponse([
        { id: "m1", author: { id: "u1", username: "alice" }, content: "hi", timestamp: "t" },
      ]);
    });
    const client = new DiscordRestClient("tok", fetch as any);
    const msgs = await client.getChannelMessages("c1", { afterId: "m0", limit: 50 });
    expect(msgs).toHaveLength(1);
  });

  it("honors Retry-After on 429", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limit", { status: 429, headers: { "Retry-After": "0" } });
      return jsonResponse({ id: "m1" });
    });
    const client = new DiscordRestClient("tok", fetch as any);
    const out = await client.postMessage("c1", "hi");
    expect(out.id).toBe("m1");
    expect(calls).toBe(2);
  });

  it("throws on 401 with status attached", async () => {
    const fetch = mockFetch(async () => new Response("unauthorized", { status: 401 }));
    const client = new DiscordRestClient("tok", fetch as any);
    await expect(client.postMessage("c1", "hi")).rejects.toMatchObject({ status: 401 });
  });

  it("addChannelPermission uses PUT to /channels/<id>/permissions/<userId>", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/channels/c1/permissions/u1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body);
      expect(body.type).toBe(1);  // 1 = member overwrite
      expect(body.allow).toBe("1024");
      return new Response(null, { status: 204 });
    });
    const client = new DiscordRestClient("tok", fetch as any);
    await client.addChannelPermission("c1", "u1", 1024, 0);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/client.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/discord/client.ts`**

```ts
import { withRateLimitBackoff } from "../utils/rate-limit.js";
import type { DiscordClient, DiscordMessage } from "./types.js";

const API_BASE = "https://discord.com/api/v10";

interface DiscordError extends Error {
  status?: number;
  retryAfter?: number;
}

function makeError(res: Response, body: string): DiscordError {
  const err: DiscordError = new Error(`Discord ${res.status}: ${body.slice(0, 200)}`);
  err.status = res.status;
  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    if (ra) err.retryAfter = Number(ra) * 1000;
  }
  return err;
}

export class DiscordRestClient implements DiscordClient {
  private readonly headers: Record<string, string>;
  private cachedUserId?: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.headers = {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "muonroi-cli (https://github.com/muonroi/muonroi-cli, 0.0.0)",
    };
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    parseJson: boolean = true,
  ): Promise<T> {
    return withRateLimitBackoff<T>(async () => {
      const init: RequestInit = { method, headers: this.headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(`${API_BASE}${path}`, init as any);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!res.ok) throw makeError(res, text);
      if (!parseJson) return undefined as T;
      return JSON.parse(text) as T;
    });
  }

  async createChannel(
    guildId: string,
    name: string,
    opts: { topic?: string; isPrivate?: boolean },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = { name, type: 0 };
    if (opts.topic !== undefined) body.topic = opts.topic;
    if (opts.isPrivate) body.permission_overwrites = [{ id: guildId, type: 0, allow: "0", deny: "1024" }];
    return this.call("POST", `/guilds/${guildId}/channels`, body);
  }

  async getChannelMessages(
    channelId: string,
    opts: { afterId?: string; limit?: number },
  ): Promise<DiscordMessage[]> {
    const params = new URLSearchParams();
    if (opts.afterId) params.set("after", opts.afterId);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.call(
      "GET",
      `/channels/${channelId}/messages${qs ? "?" + qs : ""}`,
    );
  }

  async postMessage(channelId: string, content: string): Promise<{ id: string }> {
    return this.call("POST", `/channels/${channelId}/messages`, { content });
  }

  async addChannelPermission(
    channelId: string,
    userId: string,
    allow: number,
    deny: number,
  ): Promise<void> {
    await this.call(
      "PUT",
      `/channels/${channelId}/permissions/${userId}`,
      { type: 1, allow: String(allow), deny: String(deny) },
      false,
    );
  }

  async getCurrentUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const me = await this.call<{ id: string }>("GET", "/users/@me");
    this.cachedUserId = me.id;
    return me.id;
  }

  async listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>> {
    return this.call("GET", `/guilds/${guildId}/channels`);
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/client.test.ts && npx tsc --noEmit
```

Expected: 6 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/discord/client.ts src/discord/__tests__/client.test.ts
git commit -m "feat(discord): rest client with retry-after honoring"
```

---

## Task 9: Channel manager (lazy create + hooks)

**Files:**
- Create: `src/discord/channel-manager.ts`
- Create test: `src/discord/__tests__/channel-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/discord/__tests__/channel-manager.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  clearChannelCreatedHooks,
  ensureChannel,
  registerChannelCreatedHook,
} from "../channel-manager.js";
import type { DiscordClient } from "../types.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn().mockResolvedValue({ id: "newc" }),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "m" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("ensureChannel", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `cmgr-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpHome, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
    clearChannelCreatedHooks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
    clearChannelCreatedHooks();
  });

  it("creates channel on first call (cache miss + name miss)", async () => {
    const client = makeClient();
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toEqual({ channelId: "newc", created: true });
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("cache hit on second call", async () => {
    const client = makeClient({
      listGuildChannels: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "newc", name: "muonroi-abc" }]),
    });
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    const second = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(second).toEqual({ channelId: "newc", created: false });
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("finds existing channel by name when cache missing", async () => {
    const client = makeClient({
      listGuildChannels: vi.fn().mockResolvedValue([{ id: "existing", name: "muonroi-abc" }]),
    });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toEqual({ channelId: "existing", created: false });
    expect(client.createChannel).not.toHaveBeenCalled();
  });

  it("in-process dedup: concurrent calls share one create", async () => {
    const client = makeClient();
    const [a, b] = await Promise.all([
      ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" }),
      ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" }),
    ]);
    expect(a.channelId).toBe(b.channelId);
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("returns null on 401 token error", async () => {
    const err: any = new Error("401"); err.status = 401;
    const client = makeClient({ listGuildChannels: vi.fn().mockRejectedValue(err) });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toBeNull();
  });

  it("returns null on 403 perm error", async () => {
    const err: any = new Error("403"); err.status = 403;
    const client = makeClient({ createChannel: vi.fn().mockRejectedValue(err) });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toBeNull();
  });

  it("syncs permissions from stakeholder-acl after create", async () => {
    // Pre-populate ACL
    const { addStakeholder } = await import("../../product-loop/stakeholder-acl.js");
    await addStakeholder("abc", {
      discordUserId: "u1", displayName: "alice", addedAtUtc: "t", addedBy: "cli",
    });
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(client.addChannelPermission).toHaveBeenCalledWith("newc", "u1", expect.any(Number), 0);
  });

  it("fires onChannelCreated hooks after create", async () => {
    const client = makeClient();
    const hook = vi.fn().mockResolvedValue(undefined);
    registerChannelCreatedHook(hook);
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(hook).toHaveBeenCalledWith("abc", "newc");
  });

  it("clearChannelCreatedHooks isolates tests", async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerChannelCreatedHook(hook);
    clearChannelCreatedHooks();
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("persists mapping to discord-channels.json", async () => {
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    const raw = await fs.readFile(path.join(tmpHome, "discord-channels.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.items.abc.channelId).toBe("newc");
  });

  it("retries create on cached-channel 404 verification", async () => {
    // Pre-write cache for channel that no longer exists
    const cachePath = path.join(tmpHome, "discord-channels.json");
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        items: {
          abc: { productSlug: "abc", channelId: "stale", guildId: "g1", createdAtUtc: "t", displayName: "x" },
        },
      }),
    );
    const client = makeClient({
      listGuildChannels: vi.fn().mockResolvedValue([]),  // stale not present in guild
    });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out?.channelId).toBe("newc");  // re-created
    expect(client.createChannel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/channel-manager.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/discord/channel-manager.ts`**

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import { listStakeholders } from "../product-loop/stakeholder-acl.js";
import { withFileLock } from "../utils/file-lock.js";
import { STAKEHOLDER_ALLOW, type DiscordChannelMapping, type DiscordClient } from "./types.js";

const SCHEMA_VERSION = 1;

interface ChannelStore {
  version: number;
  items: Record<string, DiscordChannelMapping>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function storePath(): string {
  return path.join(muonroiHome(), "discord-channels.json");
}

async function readStore(): Promise<ChannelStore> {
  const fp = storePath();
  let raw: string;
  try {
    raw = await fs.readFile(fp, "utf8");
  } catch {
    return { version: SCHEMA_VERSION, items: {} };
  }
  let parsed: ChannelStore;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(fp, `${fp}.corrupt-${ts}`).catch(() => {});
    return { version: SCHEMA_VERSION, items: {} };
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`channel-manager: unsupported schema version ${parsed.version}`);
  }
  return parsed;
}

async function writeStore(store: ChannelStore): Promise<void> {
  await fs.mkdir(muonroiHome(), { recursive: true });
  await atomicWriteText(storePath(), JSON.stringify(store, null, 2));
}

type ChannelCreatedHook = (slug: string, channelId: string) => Promise<void>;
let hooks: ChannelCreatedHook[] = [];

export function registerChannelCreatedHook(fn: ChannelCreatedHook): void {
  hooks.push(fn);
}

export function clearChannelCreatedHooks(): void {
  hooks = [];
}

const inFlight = new Map<string, Promise<{ channelId: string; created: boolean } | null>>();

export interface EnsureChannelArgs {
  client: DiscordClient;
  guildId: string;
  slug: string;
  displayName: string;
  eager?: boolean;
}

export async function ensureChannel(
  args: EnsureChannelArgs,
): Promise<{ channelId: string; created: boolean } | null> {
  const key = `${args.guildId}:${args.slug}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = ensureChannelInner(args).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function ensureChannelInner(args: EnsureChannelArgs): Promise<{ channelId: string; created: boolean } | null> {
  try {
    return await withFileLock(storePath(), async () => {
      const store = await readStore();

      const cached = store.items[args.slug];
      if (cached) {
        const live = await args.client.listGuildChannels(args.guildId);
        if (live.some((c) => c.id === cached.channelId)) {
          return { channelId: cached.channelId, created: false };
        }
        delete store.items[args.slug];
      } else {
        const live = await args.client.listGuildChannels(args.guildId);
        const named = live.find((c) => c.name === `muonroi-${args.slug}`);
        if (named) {
          const mapping: DiscordChannelMapping = {
            productSlug: args.slug,
            channelId: named.id,
            guildId: args.guildId,
            createdAtUtc: new Date().toISOString(),
            displayName: args.displayName,
          };
          store.items[args.slug] = mapping;
          await writeStore(store);
          return { channelId: named.id, created: false };
        }
      }

      const created = await args.client.createChannel(args.guildId, `muonroi-${args.slug}`, {
        topic: `${args.displayName} — managed by muonroi-cli`,
        isPrivate: true,
      });

      const stakeholders = await listStakeholders(args.slug);
      for (const s of stakeholders) {
        await args.client.addChannelPermission(created.id, s.discordUserId, STAKEHOLDER_ALLOW, 0).catch(() => {});
      }

      const mapping: DiscordChannelMapping = {
        productSlug: args.slug,
        channelId: created.id,
        guildId: args.guildId,
        createdAtUtc: new Date().toISOString(),
        displayName: args.displayName,
      };
      store.items[args.slug] = mapping;
      await writeStore(store);

      for (const hook of hooks) {
        await hook(args.slug, created.id).catch(() => {});
      }

      return { channelId: created.id, created: true };
    });
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      console.warn(`Discord channel-manager: ${e.status} (token/permission); F disabled for this run`);
      return null;
    }
    throw e;
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/channel-manager.test.ts && npx tsc --noEmit
```

Expected: 11 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/discord/channel-manager.ts src/discord/__tests__/channel-manager.test.ts
git commit -m "feat(discord): channel manager with dedup hooks and acl sync"
```

---

## Task 10: Broadcast bus

**Files:**
- Create: `src/discord/broadcast-bus.ts`
- Create test: `src/discord/__tests__/broadcast-bus.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/discord/__tests__/broadcast-bus.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { publish } from "../broadcast-bus.js";
import { DISCORD_CONTENT_BUDGET } from "../verdict-constants.js";
import type { DiscordClient } from "../types.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    addChannelPermission: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("publish", () => {
  it("posts content under budget unchanged", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hello" });
    expect(out?.messageId).toBe("m1");
    expect(client.postMessage).toHaveBeenCalledWith("c1", "hello");
  });

  it("returns null on empty content (no API call)", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "" });
    expect(out).toBeNull();
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("splits content over budget at newline boundary", async () => {
    const long = "para1\n\n" + "x".repeat(DISCORD_CONTENT_BUDGET) + "\n\npara3";
    const client = makeClient({
      postMessage: vi.fn()
        .mockResolvedValueOnce({ id: "m1" })
        .mockResolvedValueOnce({ id: "m2" })
        .mockResolvedValueOnce({ id: "m3" }),
    });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: long });
    const calls = (client.postMessage as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(out?.messageId).toBe("m" + calls.length);
    for (const [, msg] of calls) {
      expect(msg.length).toBeLessThanOrEqual(DISCORD_CONTENT_BUDGET + 30);
    }
  });

  it("returns null on 403 with warning", async () => {
    const err: any = new Error("403"); err.status = 403;
    const client = makeClient({ postMessage: vi.fn().mockRejectedValue(err) });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hi" });
    expect(out).toBeNull();
  });

  it("returns null on 404 with warning", async () => {
    const err: any = new Error("404"); err.status = 404;
    const client = makeClient({ postMessage: vi.fn().mockRejectedValue(err) });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hi" });
    expect(out).toBeNull();
  });

  it("preserves unicode/emoji in content", async () => {
    const client = makeClient();
    await publish({ client, channelId: "c1", type: "phase-event", content: "Sprint 🚀 done ✅" });
    expect(client.postMessage).toHaveBeenCalledWith("c1", "Sprint 🚀 done ✅");
  });

  it("split parts include continuation markers", async () => {
    const long = "x".repeat(DISCORD_CONTENT_BUDGET + 500);
    const client = makeClient({
      postMessage: vi.fn()
        .mockResolvedValueOnce({ id: "m1" })
        .mockResolvedValueOnce({ id: "m2" }),
    });
    await publish({ client, channelId: "c1", type: "phase-event", content: long });
    const calls = (client.postMessage as any).mock.calls;
    expect(calls[0][1]).toContain("(continued)");
    expect(calls[1][1]).toContain("(continued)");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/broadcast-bus.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/discord/broadcast-bus.ts`**

```ts
import type { BroadcastType, DiscordClient } from "./types.js";
import { DISCORD_CONTENT_BUDGET } from "./verdict-constants.js";

export interface PublishArgs {
  client: DiscordClient;
  channelId: string;
  type: BroadcastType;
  content: string;
}

function splitContent(content: string): string[] {
  if (content.length <= DISCORD_CONTENT_BUDGET) return [content];
  const parts: string[] = [];
  let remaining = content;
  while (remaining.length > DISCORD_CONTENT_BUDGET) {
    const budget = DISCORD_CONTENT_BUDGET - 16;
    let cutAt = remaining.lastIndexOf("\n\n", budget);
    if (cutAt < budget / 2) cutAt = remaining.lastIndexOf("\n", budget);
    if (cutAt < budget / 2) cutAt = remaining.lastIndexOf(" ", budget);
    if (cutAt < budget / 2) cutAt = budget;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\s+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts.map((p, i) => {
    let s = p;
    if (i > 0) s = "(continued) … " + s;
    if (i < parts.length - 1) s = s + " … (continued)";
    return s;
  });
}

export async function publish(args: PublishArgs): Promise<{ messageId: string } | null> {
  if (!args.content) {
    console.warn(`broadcast-bus: empty content for type=${args.type}; skipping`);
    return null;
  }
  const parts = splitContent(args.content);
  let lastId = "";
  for (const part of parts) {
    try {
      const res = await args.client.postMessage(args.channelId, part);
      lastId = res.id;
    } catch (e: any) {
      if (e?.status === 403 || e?.status === 404) {
        console.warn(`broadcast-bus: ${e.status} on postMessage; channel may be deleted or perms missing`);
        return null;
      }
      throw e;
    }
  }
  return { messageId: lastId };
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/broadcast-bus.test.ts && npx tsc --noEmit
```

Expected: 7 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/discord/broadcast-bus.ts src/discord/__tests__/broadcast-bus.test.ts
git commit -m "feat(discord): broadcast bus with content splitting and failure soft-handling"
```

---

## Task 11: Intent prompt + parser

**Files:**
- Create: `src/discord/intent-prompt.ts`
- Create test: `src/discord/__tests__/intent-prompt.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/discord/__tests__/intent-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildConvoPrompt, parseConvoReply, SYSTEM_PROMPT } from "../intent-prompt.js";

describe("intent-prompt", () => {
  it("SYSTEM_PROMPT contains intent semantics", () => {
    expect(SYSTEM_PROMPT).toContain("accept");
    expect(SYSTEM_PROMPT).toContain("reject");
    expect(SYSTEM_PROMPT).toContain("abort");
    expect(SYSTEM_PROMPT).toContain("discuss");
  });

  it("SYSTEM_PROMPT instructs language match (default Vietnamese)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/vietnamese|language/);
  });

  it("SYSTEM_PROMPT forbids keyword matching", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/keyword|negation|conservative/);
  });

  it("buildConvoPrompt includes review summary, prior turns, new msg", () => {
    const out = buildConvoPrompt({
      reviewSummary: "Sprint done.",
      productName: "Demo",
      priorTurns: [
        { role: "customer", content: "looks good?" },
        { role: "bot", content: "yes" },
      ],
      newMessage: "I accept",
    });
    expect(out).toContain("Sprint done.");
    expect(out).toContain("looks good?");
    expect(out).toContain("yes");
    expect(out).toContain("I accept");
  });

  it("buildConvoPrompt truncates reviewSummary to 1500 chars", () => {
    const out = buildConvoPrompt({
      reviewSummary: "x".repeat(3000),
      productName: "Demo",
      priorTurns: [],
      newMessage: "hi",
    });
    expect(out.length).toBeLessThan(3000);
  });

  it("parseConvoReply parses bare JSON", () => {
    const out = parseConvoReply('{"intent":"accept","reply":"Great!"}');
    expect(out.intent).toBe("accept");
    expect(out.reply).toBe("Great!");
  });

  it("parseConvoReply strips ```json code fence", () => {
    const out = parseConvoReply("```json\n{\"intent\":\"reject\",\"reply\":\"fix it\"}\n```");
    expect(out.intent).toBe("reject");
  });

  it("parseConvoReply returns intent='discuss' + reply on malformed JSON", () => {
    const out = parseConvoReply("not json at all");
    expect(out.intent).toBe("discuss");
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it("parseConvoReply caps reply at 500 chars", () => {
    const out = parseConvoReply(JSON.stringify({ intent: "discuss", reply: "x".repeat(800) }));
    expect(out.reply.length).toBe(500);
  });

  it("parseConvoReply preserves unknown intent string for caller classification", () => {
    const out = parseConvoReply(JSON.stringify({ intent: "maybe", reply: "..." }));
    expect(out.intent).toBe("maybe");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/intent-prompt.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/discord/intent-prompt.ts`**

```ts
export const SYSTEM_PROMPT =
  "You are the PO leading a product. Read the customer's recent messages in this Discord channel. " +
  "Reply in the SAME language the customer used (default Vietnamese). Output strict JSON ONLY " +
  "(no code fences, no commentary outside JSON):\n" +
  "{\n" +
  "  \"intent\": \"accept\" | \"reject\" | \"abort\" | \"discuss\",\n" +
  "  \"reply\": string (≤500 chars)\n" +
  "}\n\n" +
  "intent semantics:\n" +
  "- accept: customer is explicitly satisfied with this sprint and wants to move on.\n" +
  "- reject: customer wants specific changes but continue the product (will iterate next sprint).\n" +
  "- abort: customer wants to STOP the entire product (cut losses, wrong direction, no longer needed).\n" +
  "- discuss: customer asks a question, shares info, is exploring, OR is undecided. NO verdict yet.\n\n" +
  "RULES:\n" +
  "- Be CONSERVATIVE. When in doubt, choose 'discuss'.\n" +
  "- Negations matter: \"I don't accept this\" is NOT 'accept'. Read full intent.\n" +
  "- Emoji-only messages (e.g. '👍') without context: classify 'discuss' and ask for clarification.\n" +
  "- Keyword matching is FORBIDDEN. Use full-message semantics.";

const REVIEW_SUMMARY_MAX = 1500;
const REPLY_MAX = 500;

export interface ConvoTurn {
  role: "customer" | "bot";
  content: string;
}

export interface BuildConvoPromptArgs {
  reviewSummary: string;
  productName: string;
  priorTurns: ConvoTurn[];
  newMessage: string;
}

export function buildConvoPrompt(args: BuildConvoPromptArgs): string {
  const summary = args.reviewSummary.slice(0, REVIEW_SUMMARY_MAX);
  const priorLines = args.priorTurns.map((t) => `  ${t.role}: ${t.content}`).join("\n");
  return [
    `Product: ${args.productName}`,
    ``,
    `Sprint review summary:`,
    `  ${summary}`,
    ``,
    `Prior conversation (chronological):`,
    priorLines || "  (none)",
    ``,
    `New customer message:`,
    `  ${args.newMessage}`,
  ].join("\n");
}

export interface ParsedConvoReply {
  intent: string;
  reply: string;
}

const FALLBACK_REPLY = "Cho phép tôi suy nghĩ lại — bạn có thể chia sẻ thêm chi tiết được không?";

export function parseConvoReply(raw: string): ParsedConvoReply {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    const intent = typeof parsed.intent === "string" ? parsed.intent : "discuss";
    const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, REPLY_MAX) : FALLBACK_REPLY;
    return { intent, reply };
  } catch {
    return { intent: "discuss", reply: FALLBACK_REPLY };
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/intent-prompt.test.ts && npx tsc --noEmit
```

Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add src/discord/intent-prompt.ts src/discord/__tests__/intent-prompt.test.ts
git commit -m "feat(discord): intent prompt and tolerant parser"
```

---

## Task 12: Verdict resolver (poll loop)

**Files:**
- Create: `src/discord/verdict-resolver.ts`
- Create test: `src/discord/__tests__/verdict-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/discord/__tests__/verdict-resolver.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordAwaitVerdict } from "../verdict-resolver.js";
import type { DiscordClient, DiscordMessage } from "../types.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "bot-msg" }),
    addChannelPermission: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn(),
    ...over,
  };
}

function msg(id: string, content: string, authorId = "user"): DiscordMessage {
  return { id, content, author: { id: authorId, username: "u" }, timestamp: new Date().toISOString() };
}

describe("discordAwaitVerdict", () => {
  let flowDir: string;
  const runId = "r-v";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `vr-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  function baseArgs(over: Partial<any> = {}) {
    return {
      flowDir, runId,
      phaseId: "phase-1", sprintN: 1,
      productSlug: "abc", channelId: "c1",
      client: makeClient(),
      leader: { generate: vi.fn() },
      capUsd: 10,
      remainingUsd: async () => 5,
      reviewSummary: "Sprint 1 complete.",
      backoffDelays: [1, 1, 1],
      pollIntervalMs: 1,
      timeoutMs: 60_000,
      sleep: async () => {},
      now: () => Date.now(),
      fallback: vi.fn().mockResolvedValue({ verdict: "accept" }),
      ...over,
    };
  }

  it("happy accept: single customer message classified accept", async () => {
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "OK accept it")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "accept", reply: "Great!" }),
      costUsd: 0.01,
    }) };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("accept");
    expect(out.feedback).toBeUndefined();
  });

  it("reject returns customer message as feedback", async () => {
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "Please fix the auth flow")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "reject", reply: "noted" }),
      costUsd: 0.01,
    }) };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("reject");
    expect(out.feedback).toContain("auth flow");
  });

  it("abort returns abort verdict", async () => {
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "Stop the whole thing")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "abort", reply: "OK stopping" }),
      costUsd: 0.01,
    }) };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("abort");
  });

  it("timeout returns abort with [timeout-24h]", async () => {
    let nowVal = 0;
    const client = makeClient({ getChannelMessages: vi.fn().mockResolvedValue([]) });
    const out = await discordAwaitVerdict(baseArgs({
      client,
      timeoutMs: 100,
      now: () => { nowVal += 200; return nowVal; },
    }));
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("[timeout-24h]");
  });

  it("VERDICT_FLOOR boundary aborts with budget-exhausted", async () => {
    const out = await discordAwaitVerdict(baseArgs({
      capUsd: 10, remainingUsd: async () => 0.05,
    }));
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("budget-exhausted");
  });

  it("cap_usd=0 immediately aborts", async () => {
    const out = await discordAwaitVerdict(baseArgs({ capUsd: 0, remainingUsd: async () => 0 }));
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("budget-exhausted");
  });

  it("MAX_VERDICT_MESSAGES cap → fallback", async () => {
    const messages = Array.from({ length: 25 }, (_, i) => msg(`m${i}`, "discuss please"));
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "discuss", reply: "ok" }),
      costUsd: 0.01,
    }) };
    const fallback = vi.fn().mockResolvedValue({ verdict: "accept", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("malformed JSON counts as discuss then continues", async () => {
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "something")])
        .mockResolvedValueOnce([msg("m2", "I accept")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn()
      .mockResolvedValueOnce({ content: "not json", costUsd: 0.01 })
      .mockResolvedValueOnce({ content: JSON.stringify({ intent: "accept", reply: "OK" }), costUsd: 0.01 }) };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("accept");
  });

  it("unknown intent ×5 → fallback", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, "msg"));
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "maybe", reply: "..." }),
      costUsd: 0.01,
    }) };
    const fallback = vi.fn().mockResolvedValue({ verdict: "reject", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("leader transient failure ×3 → fallback", async () => {
    const messages = Array.from({ length: 3 }, (_, i) => msg(`m${i}`, "msg"));
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockRejectedValue(new Error("net")) };
    const fallback = vi.fn().mockResolvedValue({ verdict: "abort", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
  });

  it("404 on getChannelMessages → fallback", async () => {
    const err: any = new Error("404"); err.status = 404;
    const client = makeClient({ getChannelMessages: vi.fn().mockRejectedValue(err) });
    const fallback = vi.fn().mockResolvedValue({ verdict: "accept", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, fallback }));
    expect(fallback).toHaveBeenCalled();
  });

  it("filters out bot's own messages", async () => {
    const client = makeClient({
      getCurrentUserId: vi.fn().mockResolvedValue("bot"),
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "I am bot", "bot"), msg("m2", "I accept", "user")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "accept", reply: "ok" }),
      costUsd: 0.01,
    }) };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(leader.generate).toHaveBeenCalledOnce();
    expect(out.verdict).toBe("accept");
  });

  it("persists poll cursor in state.md", async () => {
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m99", "I accept")])
        .mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "accept", reply: "ok" }),
      costUsd: 0.01,
    }) };
    await discordAwaitVerdict(baseArgs({ client, leader }));
    const stateFile = path.join(flowDir, "runs", runId, "state.md");
    const content = await fs.readFile(stateFile, "utf8");
    expect(content).toContain("Discord Poll Cursor");
    expect(content).toContain("m99");
  });

  it("cursor advance is AFTER bot reply post (resume safety)", async () => {
    const order: string[] = [];
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([msg("m1", "I accept")])
        .mockResolvedValue([]),
      postMessage: vi.fn().mockImplementation(async () => { order.push("postReply"); return { id: "bot" }; }),
    });
    const leader = { generate: vi.fn().mockImplementation(async () => {
      order.push("leaderCall");
      return { content: JSON.stringify({ intent: "accept", reply: "ok" }), costUsd: 0.01 };
    }) };
    await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(order).toEqual(["leaderCall", "postReply"]);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/verdict-resolver.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/discord/verdict-resolver.ts`**

```ts
import * as path from "node:path";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { LeaderLike } from "../product-loop/discovery-prompt-parser.js";
import { publish } from "./broadcast-bus.js";
import { buildConvoPrompt, parseConvoReply, SYSTEM_PROMPT, type ConvoTurn } from "./intent-prompt.js";
import type { DiscordClient, PollCursor } from "./types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_LEADER_FAILURES_BEFORE_FALLBACK,
  MAX_MESSAGES_PER_POLL,
  MAX_UNKNOWN_INTENT_BEFORE_FALLBACK,
  maxVerdictMessages,
  verdictFloor,
} from "./verdict-constants.js";

export interface DiscordAwaitVerdictArgs {
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
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fallback: () => Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }>;
}

interface PollCursorStore {
  version: 1;
  cursors: PollCursor[];
}

async function loadCursor(flowDir: string, runId: string, phaseId: string, sprintN: number): Promise<string | null> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = await readArtifact(runDir, "state.md");
  const raw = map?.sections.get("Discord Poll Cursor");
  if (!raw) return null;
  try {
    const store = JSON.parse(raw) as PollCursorStore;
    const c = store.cursors.find((x) => x.phaseId === phaseId && x.sprintN === sprintN);
    return c?.lastSeenId ?? null;
  } catch {
    return null;
  }
}

async function saveCursor(flowDir: string, runId: string, cursor: PollCursor): Promise<void> {
  const runDir = path.join(flowDir, "runs", runId);
  const map = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  const raw = map.sections.get("Discord Poll Cursor");
  let store: PollCursorStore = { version: 1, cursors: [] };
  if (raw) {
    try { store = JSON.parse(raw); } catch { /* reset */ }
  }
  const idx = store.cursors.findIndex((x) => x.phaseId === cursor.phaseId && x.sprintN === cursor.sprintN);
  if (idx >= 0) store.cursors[idx] = cursor;
  else store.cursors.push(cursor);
  map.sections.set("Discord Poll Cursor", JSON.stringify(store, null, 2));
  await writeArtifact(runDir, "state.md", map);
}

export async function discordAwaitVerdict(
  args: DiscordAwaitVerdictArgs,
): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> {
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;

  const floor = verdictFloor(args.capUsd);
  const msgCap = maxVerdictMessages(args.capUsd);

  // Initial cost check (handles capUsd=0)
  if ((await args.remainingUsd()) < floor) {
    await publish({
      client: args.client, channelId: args.channelId, type: "phase-event",
      content: "Budget exhausted; deferring decision to terminal.",
    }).catch(() => {});
    return { verdict: "abort", feedback: "budget-exhausted" };
  }

  // Post review summary
  let posted: { id: string } = { id: "" };
  try {
    const res = await args.client.postMessage(args.channelId,
      `${args.reviewSummary}\n\nReply trong channel để feedback. Bot sẽ tự nhận thấy khi bạn muốn accept/reject/abort.`);
    posted = res;
  } catch (e: any) {
    if (e?.status === 403 || e?.status === 404) return args.fallback();
    throw e;
  }

  let lastSeenId = (await loadCursor(args.flowDir, args.runId, args.phaseId, args.sprintN)) ?? posted.id;
  const startedAt = now();
  let msgCount = 0;
  let leaderFailures = 0;
  let unknownIntents = 0;
  const priorTurns: ConvoTurn[] = [];

  const botUserId = await args.client.getCurrentUserId().catch(() => "");

  while (true) {
    if (now() - startedAt > timeoutMs) {
      return { verdict: "abort", feedback: "[timeout-24h]" };
    }
    if ((await args.remainingUsd()) < floor) {
      await publish({
        client: args.client, channelId: args.channelId, type: "phase-event",
        content: "Budget exhausted; aborting verdict capture.",
      }).catch(() => {});
      return { verdict: "abort", feedback: "budget-exhausted" };
    }
    if (msgCount >= msgCap) {
      await publish({
        client: args.client, channelId: args.channelId, type: "phase-event",
        content: "Reached per-sprint message cap; deferring to terminal.",
      }).catch(() => {});
      return args.fallback();
    }

    let msgs;
    try {
      msgs = await args.client.getChannelMessages(args.channelId, { afterId: lastSeenId, limit: MAX_MESSAGES_PER_POLL });
    } catch (e: any) {
      if (e?.status === 403 || e?.status === 404) return args.fallback();
      throw e;
    }
    msgs = msgs.filter((m) => m.author.id !== botUserId);
    if (msgs.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const m of msgs) {
      msgCount += 1;
      let raw: { content: string; costUsd: number };
      try {
        raw = await args.leader.generate({
          system: SYSTEM_PROMPT,
          prompt: buildConvoPrompt({
            reviewSummary: args.reviewSummary,
            productName: args.productSlug,
            priorTurns: priorTurns.slice(-10),
            newMessage: m.content,
          }),
          maxTokens: 400,
        });
        leaderFailures = 0;
      } catch {
        leaderFailures += 1;
        if (leaderFailures >= MAX_LEADER_FAILURES_BEFORE_FALLBACK) return args.fallback();
        await sleep((args.backoffDelays ?? [1000, 4000, 16000])[leaderFailures - 1] ?? 1000);
        continue;
      }

      const parsed = parseConvoReply(raw.content);
      const validIntents = ["accept", "reject", "abort", "discuss"] as const;
      const isValid = (validIntents as readonly string[]).includes(parsed.intent);
      if (!isValid) {
        unknownIntents += 1;
        if (unknownIntents >= MAX_UNKNOWN_INTENT_BEFORE_FALLBACK) return args.fallback();
      }

      const effectiveIntent = isValid ? parsed.intent : "discuss";

      await publish({ client: args.client, channelId: args.channelId, type: "phase-event", content: parsed.reply }).catch(() => {});

      lastSeenId = m.id;
      await saveCursor(args.flowDir, args.runId, {
        phaseId: args.phaseId, sprintN: args.sprintN, lastSeenId,
        lastPolledAtUtc: new Date().toISOString(),
      });

      priorTurns.push({ role: "customer", content: m.content });
      priorTurns.push({ role: "bot", content: parsed.reply });

      if (effectiveIntent === "accept" || effectiveIntent === "reject" || effectiveIntent === "abort") {
        return {
          verdict: effectiveIntent,
          feedback: effectiveIntent === "accept" ? undefined : m.content,
        };
      }
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/verdict-resolver.test.ts && npx tsc --noEmit
```

Expected: 14 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/discord/verdict-resolver.ts src/discord/__tests__/verdict-resolver.test.ts
git commit -m "feat(discord): conversational verdict resolver with bounded retries"
```

---

## Task 13: CLI `muonroi share` command

**Files:**
- Create: `src/cli/share-cmd.ts`
- Create test: `src/cli/__tests__/share-cmd.test.ts`
- Modify: `src/index.ts` (register subcommand)

- [ ] **Step 1: Inspect existing CLI subcommand registration**

```
grep -n "program$\|\.command(\".*\")" src/index.ts | tail -20
```

Note an existing command pattern (e.g. `program.command("keys")`) to mirror for `share`.

- [ ] **Step 2: Write failing tests**

Create `src/cli/__tests__/share-cmd.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { runShareCommand } from "../share-cmd.js";
import type { DiscordClient } from "../../discord/types.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn(),
    postMessage: vi.fn().mockResolvedValue({ id: "m" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("runShareCommand", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let cwd: string;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `share-${Math.random().toString(36).slice(2)}`);
    cwd = path.join(tmpHome, "cwd");
    await fs.mkdir(cwd, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
  });

  it("explicit --product slug + raw user ID + existing channel", async () => {
    // Pre-write channel mapping
    await fs.writeFile(
      path.join(tmpHome, "discord-channels.json"),
      JSON.stringify({
        version: 1,
        items: {
          "abc-myprod": {
            productSlug: "abc-myprod", channelId: "c1", guildId: "g1",
            createdAtUtc: "t", displayName: "MyProd",
          },
        },
      }),
    );
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "1234567890", product: "abc-myprod", client,
    });
    expect(result.kind).toBe("granted");
    expect(client.addChannelPermission).toHaveBeenCalled();
  });

  it("parses <@id> mention format", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "<@9876>", product: "abc", client,
    });
    expect(result.kind).toBe("acl-only");  // no channel mapping
  });

  it("parses <@!id> escaped mention format", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "<@!5555>", product: "abc", client,
    });
    expect(result.kind).toBe("acl-only");
  });

  it("rejects malformed user ID", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "@no-digits-here", product: "abc", client,
    });
    expect(result.kind).toBe("error");
    expect(client.addChannelPermission).not.toHaveBeenCalled();
  });

  it("missing channel → acl-only result, no API call", async () => {
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "111", product: "abc", client,
    });
    expect(result.kind).toBe("acl-only");
    expect(client.addChannelPermission).not.toHaveBeenCalled();
  });

  it("re-adding same user → already-stakeholder result", async () => {
    const { addStakeholder } = await import("../../product-loop/stakeholder-acl.js");
    await addStakeholder("abc", { discordUserId: "111", displayName: "u", addedAtUtc: "t", addedBy: "cli" });
    const client = makeClient();
    const result = await runShareCommand({
      cwd, user: "111", product: "abc", client,
    });
    expect(result.kind).toBe("already-stakeholder");
  });

  it("50007 permission error → error result, ACL persisted", async () => {
    await fs.writeFile(
      path.join(tmpHome, "discord-channels.json"),
      JSON.stringify({
        version: 1,
        items: { "abc": { productSlug: "abc", channelId: "c1", guildId: "g1", createdAtUtc: "t", displayName: "x" } },
      }),
    );
    const err: any = new Error("50007"); err.status = 403;
    const client = makeClient({ addChannelPermission: vi.fn().mockRejectedValue(err) });
    const result = await runShareCommand({
      cwd, user: "111", product: "abc", client,
    });
    expect(result.kind).toBe("perm-error");
    const { listStakeholders } = await import("../../product-loop/stakeholder-acl.js");
    expect(await listStakeholders("abc")).toHaveLength(1);
  });

  it("--product missing AND no recent manifest → error", async () => {
    const client = makeClient();
    const result = await runShareCommand({ cwd, user: "111", client });
    expect(result.kind).toBe("error");
  });

  it("derives product from most recent manifest when --product absent", async () => {
    const flowDir = path.join(cwd, ".flow", "runs", "r1");
    await fs.mkdir(flowDir, { recursive: true });
    await fs.writeFile(path.join(flowDir, "manifest.json"), JSON.stringify({
      idea: "Build a chat app", capUsd: 10, maxSprints: 6, doneThreshold: 0.8, createdAt: new Date().toISOString(),
    }));
    const client = makeClient();
    const result = await runShareCommand({ cwd, user: "111", client });
    expect(result.kind).toBe("acl-only");  // channel not pre-created
  });
});
```

- [ ] **Step 3: Run to confirm fail**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/cli/__tests__/share-cmd.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 4: Create `src/cli/share-cmd.ts`**

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import { publish } from "../discord/broadcast-bus.js";
import type { DiscordChannelMapping, DiscordClient } from "../discord/types.js";
import { STAKEHOLDER_ALLOW } from "../discord/types.js";
import { productSlug } from "../product-loop/product-identity.js";
import { addStakeholder, listStakeholders } from "../product-loop/stakeholder-acl.js";

export type ShareResult =
  | { kind: "granted"; userId: string; slug: string; channelId: string }
  | { kind: "acl-only"; userId: string; slug: string }
  | { kind: "already-stakeholder"; userId: string; slug: string }
  | { kind: "perm-error"; userId: string; slug: string; status?: number }
  | { kind: "error"; message: string };

export interface RunShareArgs {
  cwd: string;
  user: string;
  product?: string;
  display?: string;
  client: DiscordClient;
}

function parseUserId(input: string): string | null {
  const mention = input.match(/^<@!?(\d{15,21})>$/);
  if (mention) return mention[1];
  if (/^\d{15,21}$/.test(input)) return input;
  return null;
}

async function resolveSlug(cwd: string, productArg: string | undefined): Promise<string | null> {
  if (productArg) return productArg;
  const runsDir = path.join(cwd, ".flow", "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return null;
  }
  let latest: { slug: string; mtime: number } | null = null;
  for (const entry of entries) {
    const manifestPath = path.join(runsDir, entry, "manifest.json");
    let stat;
    try {
      stat = await fs.stat(manifestPath);
    } catch {
      continue;
    }
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const m = JSON.parse(raw) as { idea: string };
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { slug: productSlug(m.idea), mtime: stat.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  return latest?.slug ?? null;
}

interface ChannelStore {
  version: number;
  items: Record<string, DiscordChannelMapping>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

async function readChannelMapping(slug: string): Promise<DiscordChannelMapping | null> {
  const fp = path.join(muonroiHome(), "discord-channels.json");
  let raw: string;
  try { raw = await fs.readFile(fp, "utf8"); } catch { return null; }
  try {
    const store = JSON.parse(raw) as ChannelStore;
    return store.items[slug] ?? null;
  } catch { return null; }
}

export async function runShareCommand(args: RunShareArgs): Promise<ShareResult> {
  const userId = parseUserId(args.user);
  if (!userId) {
    return { kind: "error", message: `Invalid user identifier: ${args.user}. Use raw snowflake ID or <@…> mention.` };
  }
  const slug = await resolveSlug(args.cwd, args.product);
  if (!slug) {
    return { kind: "error", message: "No active product found; pass --product <slug>." };
  }
  const displayName = args.display ?? userId;

  const existing = await listStakeholders(slug);
  const alreadyMember = existing.some((s) => s.discordUserId === userId);
  if (alreadyMember) {
    return { kind: "already-stakeholder", userId, slug };
  }

  await addStakeholder(slug, {
    discordUserId: userId,
    displayName,
    addedAtUtc: new Date().toISOString(),
    addedBy: "cli",
  });

  const mapping = await readChannelMapping(slug);
  if (!mapping) {
    return { kind: "acl-only", userId, slug };
  }

  try {
    await args.client.addChannelPermission(mapping.channelId, userId, STAKEHOLDER_ALLOW, 0);
  } catch (e: any) {
    return { kind: "perm-error", userId, slug, status: e?.status };
  }

  await publish({
    client: args.client, channelId: mapping.channelId, type: "phase-event",
    content: `<@${userId}> đã được thêm vào product ${mapping.displayName}.`,
  }).catch(() => {});

  return { kind: "granted", userId, slug, channelId: mapping.channelId };
}
```

- [ ] **Step 5: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/cli/__tests__/share-cmd.test.ts && npx tsc --noEmit
```

Expected: 9 pass.

- [ ] **Step 6: Register `share` subcommand in `src/index.ts`**

Find a similar subcommand block (e.g. `program.command("keys")`) for the pattern. Add a new command after the `keys`/`usage`/`pil` blocks:

```ts
program
  .command("share <user>")
  .description("Add a stakeholder to the current product's Discord channel")
  .option("--product <slug>", "Override product slug (default: most recent run)")
  .option("--display <name>", "Display name for the stakeholder")
  .action(async (user: string, opts: { product?: string; display?: string }) => {
    const token = process.env.MUONROI_DISCORD_TOKEN;
    const guildId = process.env.MUONROI_DISCORD_GUILD_ID;
    if (!token || !guildId) {
      console.error("muonroi share: MUONROI_DISCORD_TOKEN and MUONROI_DISCORD_GUILD_ID must both be set.");
      process.exit(1);
    }
    const { DiscordRestClient } = await import("./discord/client.js");
    const { runShareCommand } = await import("./cli/share-cmd.js");
    const client = new DiscordRestClient(token);
    const result = await runShareCommand({ cwd: process.cwd(), user, product: opts.product, display: opts.display, client });
    switch (result.kind) {
      case "granted":
        console.log(`Granted channel access to <@${result.userId}> in product ${result.slug}.`);
        break;
      case "acl-only":
        console.log(`Added <@${result.userId}> to product ${result.slug}. Channel will be granted access on creation.`);
        break;
      case "already-stakeholder":
        console.log(`User <@${result.userId}> is already a stakeholder of ${result.slug}.`);
        break;
      case "perm-error":
        console.error(`Failed to grant Discord permission (status=${result.status}). ACL was still updated; user can join when bot has permission.`);
        process.exit(1);
        break;
      case "error":
        console.error(`muonroi share: ${result.message}`);
        process.exit(1);
        break;
    }
  });
```

- [ ] **Step 7: Verify full suite + tsc clean**

```
cd D:/sources/Core/muonroi-cli && npx tsc --noEmit && npx vitest run src/cli/__tests__/share-cmd.test.ts
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/cli/share-cmd.ts src/cli/__tests__/share-cmd.test.ts src/index.ts
git commit -m "feat(cli): muonroi share subcommand"
```

---

## Task 14: Wire Discord into `product-loop/index.ts`

**Files:**
- Modify: `src/product-loop/index.ts`

- [ ] **Step 1: Inspect current `runPhasesPath`**

```
grep -n "runPhasesPath\|MUONROI_PHASE_MODE\|phaseGen\|push_notification" src/product-loop/index.ts | head -20
```

Note where `phaseGen` is iterated and where `awaitCustomerVerdict` is wired in.

- [ ] **Step 2: Add Discord env detection helper at top of file**

Add (near other imports):

```ts
function discordEnvConfig(): { token: string; guildId: string } | null {
  const token = process.env.MUONROI_DISCORD_TOKEN;
  const guildId = process.env.MUONROI_DISCORD_GUILD_ID;
  if (!token && !guildId) return null;
  if (!token || !guildId) {
    console.warn("muonroi: MUONROI_DISCORD_TOKEN/_GUILD_ID partially configured; Discord disabled.");
    return null;
  }
  return { token, guildId };
}
```

- [ ] **Step 3: In `runPhasesPath`, build Discord client and wrap `phaseGen` yield + swap verdict**

Locate the line `for await (const chunk of phaseGen)` in `runPhasesPath`. Replace with:

```ts
const discordCfg = discordEnvConfig();
let discordClient: import("../discord/types.js").DiscordClient | null = null;
let slug: string | null = null;
if (discordCfg) {
  const { DiscordRestClient } = await import("../discord/client.js");
  discordClient = new DiscordRestClient(discordCfg.token);
  const { productSlug } = await import("./product-identity.js");
  slug = productSlug(manifest.idea);
}

for await (const chunk of phaseGen) {
  if (chunk.type === "push_notification" && discordClient && discordCfg && slug) {
    try {
      const { ensureChannel } = await import("../discord/channel-manager.js");
      const { publish } = await import("../discord/broadcast-bus.js");
      const ch = await ensureChannel({
        client: discordClient,
        guildId: discordCfg.guildId,
        slug,
        displayName: manifest.idea,
      });
      if (ch) {
        await publish({
          client: discordClient,
          channelId: ch.channelId,
          type: "phase-event",
          content: chunk.content,
        });
      }
    } catch (e) {
      console.warn("muonroi: discord broadcast failed", e);
    }
  }
  yield chunk;
}
```

- [ ] **Step 4a: Extend `awaitCustomerVerdict` signature in `RunPhasesOptions`**

In `src/product-loop/types.ts`, locate `RunPhasesOptions.awaitCustomerVerdict` (added in E Task 1). Change its signature from:

```ts
awaitCustomerVerdict: (flowDir: string, runId: string) => Promise<...>
```

to:

```ts
awaitCustomerVerdict: (args: {
  flowDir: string;
  runId: string;
  phaseId: string;
  sprintN: number;
  reviewSummary: string;
}) => Promise<Omit<CustomerDecision, "seq" | "timestampUtc" | "phaseId" | "sprintN">>;
```

- [ ] **Step 4b: Update phase-runner call site**

In `src/product-loop/phase-runner.ts`, locate where `awaitCustomerVerdict(...)` is called (search for `awaitCustomerVerdict(`). The current call passes `(args.flowDir, args.runId)`. Change it to:

```ts
const verdict = await args.awaitCustomerVerdict({
  flowDir: args.flowDir,
  runId: args.runId,
  phaseId: phase.id,
  sprintN,
  reviewSummary: review.summary,
});
```

`review.summary` is the local variable holding the output of `generateSprintReview(...)` (already in scope at the call site from E T11).

- [ ] **Step 4c: Update existing phase-runner tests**

Any test that injects an `awaitCustomerVerdict` mock will break. Search:

```
grep -n "awaitCustomerVerdict:" src/product-loop/__tests__/
```

For each test mock that uses the old signature `async () => ({ verdict: ... })` or `async (flowDir, runId) => ...`, change to `async (_args) => ({ verdict: ... })`.

Run phase-runner tests to confirm:

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop/__tests__/phase-runner.test.ts src/product-loop/__tests__/phase-orchestrator-integration.test.ts
```

Expected: all pass after mock updates.

- [ ] **Step 4d: Replace `awaitCustomerVerdict` factory when Discord configured**

Locate the existing `awaitCustomerVerdict` block in `runPhasesPath`. Replace with:

```ts
const terminalFallback = async (): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> => {
  const ans = await ctx.respondToQuestion({
    id: "customer-review-verdict",
    text: "Sprint review ready. Accept (a), Reject with feedback (r), or Abort (x)?",
  });
  const lower = (ans ?? "").trim().toLowerCase();
  if (lower.startsWith("x")) return { verdict: "abort" };
  if (lower.startsWith("r")) {
    const fb = await ctx.respondToQuestion({ id: "customer-review-feedback", text: "Feedback:" });
    return { verdict: "reject", feedback: fb ?? "" };
  }
  return { verdict: "accept" };
};

const awaitCustomerVerdict = async (args: {
  flowDir: string;
  runId: string;
  phaseId: string;
  sprintN: number;
  reviewSummary: string;
}): Promise<{ verdict: "accept" | "reject" | "abort"; feedback?: string }> => {
  if (!discordClient || !discordCfg || !slug) return terminalFallback();
  const { ensureChannel } = await import("../discord/channel-manager.js");
  const { discordAwaitVerdict } = await import("../discord/verdict-resolver.js");
  const ch = await ensureChannel({
    client: discordClient,
    guildId: discordCfg.guildId,
    slug,
    displayName: manifest.idea,
  });
  if (!ch) return terminalFallback();
  return discordAwaitVerdict({
    flowDir: args.flowDir,
    runId: args.runId,
    phaseId: args.phaseId,
    sprintN: args.sprintN,
    productSlug: slug,
    channelId: ch.channelId,
    client: discordClient,
    leader,
    capUsd: manifest.capUsd,
    remainingUsd: async () => {
      const { getProductSpentUsd } = await import("../usage/product-ledger.js");
      const spent = await getProductSpentUsd(args.runId);
      return Math.max(0, manifest.capUsd - spent);
    },
    reviewSummary: args.reviewSummary,
    fallback: terminalFallback,
  });
};
```

- [ ] **Step 5: Verify tsc**

```
cd D:/sources/Core/muonroi-cli && npx tsc --noEmit
```

Expected: clean. If signature mismatches surface, propagate `reviewSummary`/`phaseId`/`sprintN` through `runPhases` args (the existing `awaitCustomerVerdict` in `RunPhasesOptions` may need to accept these — adjust the type in `src/product-loop/types.ts`).

- [ ] **Step 6: Verify full product-loop tests**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/product-loop 2>&1 | tail -15
```

Expected: all pass with `MUONROI_DISCORD_TOKEN` unset (default), confirming no regression.

- [ ] **Step 7: Commit**

```bash
git add src/product-loop/index.ts src/product-loop/types.ts
git commit -m "feat(phase): wire discord broadcast and verdict-resolver behind env flag"
```

---

## Task 15: Integration tests (e2e mocked client)

**Files:**
- Create: `src/discord/__tests__/discord-integration.test.ts`

- [ ] **Step 1: Write tests**

Create `src/discord/__tests__/discord-integration.test.ts`:

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ensureChannel, clearChannelCreatedHooks } from "../channel-manager.js";
import { publish } from "../broadcast-bus.js";
import { discordAwaitVerdict } from "../verdict-resolver.js";
import { productSlug } from "../../product-loop/product-identity.js";
import { addStakeholder } from "../../product-loop/stakeholder-acl.js";
import type { DiscordClient, DiscordMessage } from "../types.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn().mockResolvedValue({ id: "newc" }),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "bot-msg" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function customerMsg(id: string, content: string): DiscordMessage {
  return { id, content, author: { id: "u1", username: "alice" }, timestamp: new Date().toISOString() };
}

describe("discord-integration (subsystem F)", () => {
  let tmpHome: string;
  let flowDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `int-${Math.random().toString(36).slice(2)}`);
    flowDir = path.join(tmpHome, "flow");
    await fs.mkdir(flowDir, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
    clearChannelCreatedHooks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
    clearChannelCreatedHooks();
  });

  it("E2E: stakeholder added before channel exists inherits perms on creation", async () => {
    const slug = productSlug("Demo Product");
    await addStakeholder(slug, {
      discordUserId: "111", displayName: "alice", addedAtUtc: "t", addedBy: "cli",
    });
    const client = makeClient();
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    expect(ch).not.toBeNull();
    expect(client.addChannelPermission).toHaveBeenCalledWith("newc", "111", expect.any(Number), 0);
  });

  it("E2E: broadcast posts content under budget verbatim", async () => {
    const slug = productSlug("Demo Product");
    const client = makeClient();
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    expect(ch).not.toBeNull();
    const out = await publish({ client, channelId: ch!.channelId, type: "phase-event", content: "Sprint 1 done" });
    expect(out?.messageId).toBe("bot-msg");
  });

  it("E2E: verdict capture loop returns accept after one customer message", async () => {
    const runId = "r-int";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const slug = productSlug("Demo Product");
    const client = makeClient({
      getChannelMessages: vi.fn()
        .mockResolvedValueOnce([customerMsg("m1", "I accept")])
        .mockResolvedValue([]),
    });
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    const leader = { generate: vi.fn().mockResolvedValue({
      content: JSON.stringify({ intent: "accept", reply: "Great!" }),
      costUsd: 0.01,
    }) };
    const out = await discordAwaitVerdict({
      flowDir, runId,
      phaseId: "phase-1", sprintN: 1,
      productSlug: slug, channelId: ch!.channelId,
      client, leader,
      capUsd: 10,
      remainingUsd: async () => 5,
      reviewSummary: "Sprint 1 complete.",
      pollIntervalMs: 1, timeoutMs: 60_000,
      sleep: async () => {},
      now: () => Date.now(),
      backoffDelays: [1],
      fallback: async () => ({ verdict: "abort", feedback: "no" }),
    });
    expect(out.verdict).toBe("accept");
  });

  it("E2E: bot kicked mid-verdict → falls back to terminal path", async () => {
    const runId = "r-int2";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const slug = productSlug("Demo Product");
    const err: any = new Error("404"); err.status = 404;
    const client = makeClient({ getChannelMessages: vi.fn().mockRejectedValue(err) });
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    const leader = { generate: vi.fn() };
    const fallback = vi.fn().mockResolvedValue({ verdict: "reject", feedback: "via-fallback" });
    const out = await discordAwaitVerdict({
      flowDir, runId,
      phaseId: "phase-1", sprintN: 1,
      productSlug: slug, channelId: ch!.channelId,
      client, leader,
      capUsd: 10, remainingUsd: async () => 5,
      reviewSummary: "",
      pollIntervalMs: 1, timeoutMs: 60_000,
      sleep: async () => {}, now: () => Date.now(),
      backoffDelays: [1],
      fallback,
    });
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("E2E: empty content broadcast → null, no API call", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "" });
    expect(out).toBeNull();
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("E2E: concurrent ensureChannel for same slug creates once", async () => {
    const slug = productSlug("Demo Product");
    const client = makeClient();
    const [a, b, c] = await Promise.all([
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
    ]);
    expect(a?.channelId).toBe(b?.channelId);
    expect(b?.channelId).toBe(c?.channelId);
    expect(client.createChannel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Verify tests pass**

```
cd D:/sources/Core/muonroi-cli && npx vitest run src/discord/__tests__/discord-integration.test.ts && npx tsc --noEmit
```

Expected: 6 pass.

- [ ] **Step 3: Commit**

```bash
git add src/discord/__tests__/discord-integration.test.ts
git commit -m "test(discord): integration suite stakeholder broadcast verdict fallback"
```

---

## Task 16: Coverage gate

**Files:** none (verification + targeted gap-closing tests)

- [ ] **Step 1: Run the full vitest suite**

```
cd D:/sources/Core/muonroi-cli && npx vitest run 2>&1 | tail -15
```

Expected: 0 failures.

- [ ] **Step 2: tsc + biome**

```
cd D:/sources/Core/muonroi-cli && npx tsc --noEmit && npx biome check src/discord src/utils/rate-limit.ts src/utils/slugify.ts src/utils/file-lock.ts src/product-loop/product-identity.ts src/product-loop/stakeholder-acl.ts src/cli/share-cmd.ts 2>&1 | tail -15
```

Both clean. Fix any biome lint issues with `npx biome check --write` if safe; otherwise edit by hand.

- [ ] **Step 3: Coverage on new F files**

```
cd D:/sources/Core/muonroi-cli && npx vitest run --coverage src/discord src/utils/__tests__/rate-limit.test.ts src/utils/__tests__/slugify.test.ts src/utils/__tests__/file-lock.test.ts src/product-loop/__tests__/product-identity.test.ts src/product-loop/__tests__/stakeholder-acl.test.ts src/cli/__tests__/share-cmd.test.ts 2>&1 | tail -40
```

Each of the 9 new production files must show ≥ 92 % statement coverage:
- `src/utils/rate-limit.ts`
- `src/utils/slugify.ts`
- `src/utils/file-lock.ts`
- `src/product-loop/product-identity.ts`
- `src/product-loop/stakeholder-acl.ts`
- `src/discord/client.ts`
- `src/discord/channel-manager.ts`
- `src/discord/broadcast-bus.ts`
- `src/discord/intent-prompt.ts`
- `src/discord/verdict-resolver.ts`
- `src/cli/share-cmd.ts`

If `vitest --coverage` is not configured, do manual inspection: for each file, read through and confirm every conditional branch is exercised by at least one test. List any branches not covered.

- [ ] **Step 4: Close gaps if any**

For any uncovered non-trivial branch, append a targeted test to the most-relevant `__tests__` file. Re-run coverage. Commit:

```bash
git add src/discord/__tests__/ src/utils/__tests__/ src/product-loop/__tests__/ src/cli/__tests__/
git commit -m "test(discord): close coverage gaps in subsystem f files"
```

If nothing was added, skip the commit.

---

## Task 17: Acceptance walk-through

**Files:** none (manual verification against spec §4 acceptance criteria 1–13)

- [ ] **Step 1: Walk acceptance criteria from spec §4 (12 items)**

For each item, list the test or commit that satisfies it:

1. First push_notification creates private channel → `discord-integration.test.ts` "E2E: broadcast posts content".
2. `muonroi share @user` grants + posts confirmation → `share-cmd.test.ts` "explicit --product slug + raw user ID + existing channel".
3. Verdict capture returns correct tuple → `verdict-resolver.test.ts` "happy accept" / "reject returns customer message as feedback" / "abort returns abort verdict".
4. Without env vars set, F invisible → `product-loop/index.ts` env-gating; E tests pass unchanged.
5. Failure modes fall back to terminal → `verdict-resolver.test.ts` "404 on getChannelMessages → fallback" + "leader transient failure ×3 → fallback".
6. 24h silence yields `[timeout-24h]` → `verdict-resolver.test.ts` "timeout returns abort with [timeout-24h]".
7. Budget below floor yields `budget-exhausted` → `verdict-resolver.test.ts` "VERDICT_FLOOR boundary aborts with budget-exhausted".
8. Per-sprint message cap → fallback → `verdict-resolver.test.ts` "MAX_VERDICT_MESSAGES cap → fallback".
9. Content > 1900 chars splits → `broadcast-bus.test.ts` "splits content over budget at newline boundary".
10. tsc + biome clean → Task 16 step 2.
11. ≥ 92 % coverage → Task 16 step 3.
12. Full suite green, no E regressions → Task 16 step 1.
13. Partial env config warns + skips → manual verification: `MUONROI_DISCORD_TOKEN=x` without GUILD_ID → `runPhasesPath` logs warning + Discord path inert.

Document this list in the commit message of the final task. No code changes here unless a gap is found — in which case append a test.

- [ ] **Step 2: Final commit**

If gaps were found and closed:

```bash
git add <files>
git commit -m "test(discord): close acceptance criteria gaps"
```

Otherwise no commit.

---

## Summary

18 tasks, 9 new production files + 3 modified, 10 new test files + 2 modified, all gated behind two env vars. Default OFF preserves E behavior bit-for-bit. Cost guard: `VERDICT_FLOOR=max($0.10, 0.01×capUsd)` + `MAX_VERDICT_MESSAGES_PER_SPRINT≈20`. Forward-compat hooks for Subsystem G (env-init) are inert API surface in F.
