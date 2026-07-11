import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "../storage/db.js";
import type { CostForensicsRow, CostForensicsSummary } from "./cost-forensics.js";
import { computeCacheCadence, printCostForensics } from "./cost-forensics.js";

// ─── Fake DB for resolveSessionIds tests ────────────────────────────────────
// The sessions table rows keyed by id, ordered by created_at DESC for LIKE queries.
const fakeSessionRows: Array<{ id: string; created_at: string }> = [];

function makeFakeDb() {
  return {
    prepare: (sql: string) => ({
      all: (pattern: string) => {
        if (sql.includes("FROM sessions") && sql.includes("LIKE")) {
          // Simulate: WHERE id LIKE ? ORDER BY created_at DESC LIMIT 5
          const prefix = pattern.replace(/%$/, "");
          return fakeSessionRows
            .filter((r) => r.id.startsWith(prefix))
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, 5);
        }
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    }),
    exec: () => undefined,
    pragma: () => undefined,
    transaction: <T>(fn: () => T) => fn,
    close: () => undefined,
  };
}

vi.mock("../storage/db.js", () => ({
  getDatabase: vi.fn(() => makeFakeDb()),
}));

function event(overrides: Partial<CostForensicsRow> = {}): CostForensicsRow {
  return {
    id: overrides.id ?? 1,
    source: overrides.source ?? "message",
    model: overrides.model ?? "deepseek-v4-flash",
    messageSeq: overrides.messageSeq ?? null,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    costMicros: overrides.costMicros ?? 0,
    createdAt: overrides.createdAt ?? "2026-05-15T12:00:00.000Z",
    providerOptionsShape: overrides.providerOptionsShape ?? null,
  };
}

function summary(events: CostForensicsRow[]): CostForensicsSummary {
  const totalInput = events.reduce((s, e) => s + e.inputTokens, 0);
  const totalCacheRead = events.reduce((s, e) => s + e.cacheReadTokens, 0);
  const totalCacheCreation = events.reduce((s, e) => s + e.cacheCreationTokens, 0);
  return {
    sessionId: "test-session",
    rowCount: events.length,
    userPromptCount: 1,
    toolCallCount: 0,
    totalInput,
    totalOutput: events.reduce((s, e) => s + e.outputTokens, 0),
    totalCacheRead,
    totalCacheCreation,
    totalCostUsd: 0,
    cacheHitRatio: totalInput > 0 ? totalCacheRead / totalInput : 0,
    peakSingleCallInput: Math.max(0, ...events.map((e) => e.inputTokens)),
    peakSingleCallFresh: Math.max(0, ...events.map((e) => Math.max(0, e.inputTokens - e.cacheReadTokens))),
    events,
    experience: null,
  };
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // Narrow override for the duration of the call.
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

describe("printCostForensics", () => {
  it("flags a Phase B breach when peak single-call FRESH input exceeds 80k", () => {
    // Genuine cold cap-escape: 504,737 input, mostly fresh (little cache reuse).
    const out = captureStdout(() =>
      printCostForensics(summary([event({ source: "task", inputTokens: 504_737, cacheReadTokens: 20_000 })])),
    );
    expect(out).toContain("Phase B target breach");
    expect(out).toContain("484,737"); // fresh = 504,737 - 20,000
  });

  it("does NOT flag a breach when high input is aggregate multi-step reuse (high cache hit)", () => {
    // Real case, session 6f17a13c1591: task totalUsage aggregated across steps —
    // 378,613 input but 324,224 cache-read → only 54,389 fresh. Not a cap breach.
    const out = captureStdout(() =>
      printCostForensics(summary([event({ source: "task", inputTokens: 378_613, cacheReadTokens: 324_224 })])),
    );
    expect(out).not.toContain("Phase B target breach");
    expect(out).toContain("aggregate multi-step reuse");
  });

  it("flags the NULL message_seq regression (A5 write-ahead bypass)", () => {
    const out = captureStdout(() =>
      printCostForensics(summary([event({ source: "message", inputTokens: 10_000, messageSeq: null })])),
    );
    expect(out).toContain("A5 message write-ahead bypassed");
  });

  it("flags deepseek route only when deepseek events sum >50k input with zero cache_creation", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([
          event({ source: "message", model: "deepseek-v4-flash", inputTokens: 60_000, cacheCreationTokens: 0 }),
        ]),
      ),
    );
    expect(out).toContain("deepseek route has zero cache_creation_tokens");
  });

  it("does NOT fire the deepseek anomaly on a pure non-deepseek session", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([event({ source: "message", model: "gpt-5.4", inputTokens: 60_000, cacheCreationTokens: 0 })]),
      ),
    );
    expect(out).not.toContain("deepseek route has zero cache_creation_tokens");
  });

  it("does NOT fire the deepseek anomaly when deepseek events sum under the 50k threshold", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([
          event({ source: "message", model: "gpt-5.4", inputTokens: 60_000, cacheCreationTokens: 0 }),
          event({ source: "message", model: "deepseek-v4-flash", inputTokens: 5_000, cacheCreationTokens: 0 }),
        ]),
      ),
    );
    expect(out).not.toContain("deepseek route has zero cache_creation_tokens");
  });

  it("reports no anomalies on a healthy session", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([
          event({
            source: "message",
            model: "claude-sonnet-4-6",
            inputTokens: 5_000,
            messageSeq: 1,
            cacheCreationTokens: 1_200,
          }),
        ]),
      ),
    );
    expect(out).toContain("No acceptance-target anomalies detected");
  });

  it("emits valid JSON with --json", () => {
    const out = captureStdout(() => printCostForensics(summary([event({ inputTokens: 100 })]), { json: true }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.sessionId).toBe("test-session");
    expect(Array.isArray(parsed.events)).toBe(true);
  });
});

describe("computeCacheCadence", () => {
  it("estimates re-billed tokens for calls that miss a cacheable prefix AFTER warm-up", () => {
    // Prefix proven cacheable (call 2 hit 16,896). Calls 3-4 read 0% despite it
    // → fast-loop latency re-bill. Call 1 cold-start is NOT counted.
    const c = computeCacheCadence([
      event({ source: "message", inputTokens: 17_000, cacheReadTokens: 0 }), // cold start (not counted)
      event({ source: "message", inputTokens: 18_000, cacheReadTokens: 16_896 }), // warm-up hit
      event({ source: "message", inputTokens: 19_000, cacheReadTokens: 0 }), // missed (re-bill)
      event({ source: "message", inputTokens: 20_000, cacheReadTokens: 0 }), // missed (re-bill)
    ]);
    expect(c.warmPrefixTokens).toBe(16_896);
    expect(c.coldCallsAfterWarmup).toBe(2);
    expect(c.estReBilledTokens).toBe(33_792);
  });

  it("reports zero re-bill when every post-warm call keeps the cache", () => {
    const c = computeCacheCadence([
      event({ source: "message", inputTokens: 17_000, cacheReadTokens: 0 }),
      event({ source: "message", inputTokens: 18_000, cacheReadTokens: 16_896 }),
      event({ source: "message", inputTokens: 18_500, cacheReadTokens: 16_896 }),
    ]);
    expect(c.coldCallsAfterWarmup).toBe(0);
    expect(c.estReBilledTokens).toBe(0);
  });

  it("reports zero warmPrefix when the cache never warmed (cold session)", () => {
    const c = computeCacheCadence([
      event({ source: "message", inputTokens: 17_000, cacheReadTokens: 0 }),
      event({ source: "message", inputTokens: 18_000, cacheReadTokens: 0 }),
    ]);
    expect(c.warmPrefixTokens).toBe(0);
    expect(c.coldCallsAfterWarmup).toBe(0);
    expect(c.estReBilledTokens).toBe(0);
  });

  it("ignores non-message events (task/sub-agent) in the cadence window", () => {
    const c = computeCacheCadence([
      event({ source: "message", inputTokens: 18_000, cacheReadTokens: 16_896 }),
      event({ source: "task", inputTokens: 90_000, cacheReadTokens: 0 }), // sub-agent, not the top-level loop
      event({ source: "message", inputTokens: 19_000, cacheReadTokens: 0 }),
    ]);
    expect(c.messageCalls).toBe(2);
    expect(c.coldCallsAfterWarmup).toBe(1);
  });
});

describe("printCostForensics — cache cadence line", () => {
  it("prints the re-bill diagnostic when post-warm calls miss the prefix", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([
          event({ source: "message", inputTokens: 17_000, cacheReadTokens: 0 }),
          event({ source: "message", inputTokens: 18_000, cacheReadTokens: 16_896 }),
          event({ source: "message", inputTokens: 19_000, cacheReadTokens: 0 }),
          event({ source: "message", inputTokens: 20_000, cacheReadTokens: 0 }),
        ]),
      ),
    );
    expect(out).toContain("Cache cadence");
    expect(out).toContain("33,792");
  });

  it("does NOT print the cadence line when there is no post-warm miss", () => {
    const out = captureStdout(() =>
      printCostForensics(
        summary([
          event({ source: "message", inputTokens: 18_000, cacheReadTokens: 16_896 }),
          event({ source: "message", inputTokens: 18_500, cacheReadTokens: 16_896 }),
        ]),
      ),
    );
    expect(out).not.toContain("Cache cadence");
  });
});

import { resolveSessionIds } from "./cost-forensics.js";

describe("resolveSessionIds", () => {
  beforeEach(() => {
    fakeSessionRows.length = 0;
    // Seed two sessions sharing the "deadbeef" prefix; 0002 is newer.
    fakeSessionRows.push({ id: "deadbeef0001", created_at: "2026-01-01T00:00:00.000Z" });
    fakeSessionRows.push({ id: "deadbeef0002", created_at: "2026-01-02T00:00:00.000Z" });
  });
  afterEach(() => {
    fakeSessionRows.length = 0;
  });

  it("returns all session ids matching a prefix, newest first", () => {
    const ids = resolveSessionIds("deadbeef");
    expect(ids).toContain("deadbeef0001");
    expect(ids).toContain("deadbeef0002");
    expect(ids[0]).toBe("deadbeef0002"); // newest (later created_at) first
  });

  it("returns empty array for an unknown prefix", () => {
    expect(resolveSessionIds("zzzznomatch")).toEqual([]);
  });

  it("resolveSessionIds queries newest-first via SQL ORDER BY DESC", () => {
    let capturedSql = "";
    vi.mocked(getDatabase).mockReturnValueOnce({
      prepare: (sql: string) => {
        capturedSql = sql;
        return { all: () => [] as Array<{ id: string }> };
      },
    } as never);
    resolveSessionIds("anything");
    expect(capturedSql).toContain("ORDER BY created_at DESC");
  });
});
