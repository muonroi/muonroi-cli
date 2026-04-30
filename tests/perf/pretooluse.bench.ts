/**
 * EE-08: PreToolUse p95 <= 25ms guard.
 *
 * Runs 200 intercept cycles against a local stub EE server.
 * The p95 latency MUST stay at or below 25ms. CI workflow perf-guard.yml
 * runs this on every PR to prevent regressions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startStubEEServer, type StubHandle } from "../../src/__test-stubs__/ee-server.js";
import { setDefaultEEClient } from "../../src/ee/intercept.js";
import { createEEClient } from "../../src/ee/client.js";
import { intercept } from "../../src/ee/intercept.js";

describe("EE-08: PreToolUse p95 <= 25ms", () => {
  let stub: StubHandle;

  beforeAll(async () => {
    stub = await startStubEEServer({
      intercept: () => ({ decision: "allow" }),
    });
    setDefaultEEClient(
      createEEClient({ baseUrl: `http://localhost:${stub.port}` }),
    );
  });

  afterAll(async () => {
    await stub.stop();
    // Reset default client so other tests are not affected
    setDefaultEEClient(null as any);
  });

  it("200 cycles localhost stub", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await intercept({
        toolName: "Edit",
        toolInput: { path: "x.ts" },
        cwd: process.cwd(),
        tenantId: "local",
        scope: { kind: "global" },
      });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `p50=${samples[Math.floor(samples.length * 0.5)].toFixed(2)}ms ` +
        `p95=${p95.toFixed(2)}ms ` +
        `p99=${samples[Math.floor(samples.length * 0.99)].toFixed(2)}ms`,
    );
    expect(p95).toBeLessThanOrEqual(25);
  });
});
