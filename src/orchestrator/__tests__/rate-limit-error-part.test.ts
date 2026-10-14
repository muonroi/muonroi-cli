/**
 * A rate limit that arrives as an in-stream ERROR PART (request accepted, then
 * refused) never reaches the gate's 429 retry, which only sees rejected
 * requests. The main turn must still wait it out on the rate-limit schedule —
 * honouring the provider's Retry-After — and then answer, instead of ending the
 * turn with the error. Drives the REAL MessageProcessor + tool engine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMockModel, type StreamChunks, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import type { StreamChunk } from "../../types/index.js";
import { Agent } from "../orchestrator.js";

const MODEL_ID = "deepseek-v4-flash";

function rateLimitedPartStream(retryAfterMs: number): StreamChunks {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "error",
      error: new APICallError({
        message: "Rate limit reached, please try again later.",
        url: "https://provider.invalid/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after-ms": String(retryAfterMs) },
        isRetryable: true,
      }),
    },
  ] as unknown as StreamChunks;
}

const ENV_KEYS = ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL", "MUONROI_DISABLE_GROUNDING_CHECK"];

describe("main turn — rate limit delivered as an error part", () => {
  let home: string;
  let previousCwd: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-rl-part-"));
    previousCwd = process.cwd();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: false }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_DISABLE_GROUNDING_CHECK = "1";
    closeDatabase();
    await loadCatalog();
  });

  afterEach(() => {
    closeDatabase();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("waits for the provider's Retry-After, retries, and answers", async () => {
    const handle = installMockModel({
      fixture: { autoClassify: true, stream: [rateLimitedPartStream(1_500), textOnlyStream("Done after the wait.")] },
    });
    try {
      const agent = new Agent("test-key", undefined, MODEL_ID, 3, { persistSession: true });
      const chunks: StreamChunk[] = [];
      const started = Date.now();
      for await (const chunk of agent.processMessage("Summarise the plan.")) chunks.push(chunk);
      const elapsed = Date.now() - started;
      const content = chunks
        .filter((c) => c.type === "content")
        .map((c) => c.content)
        .join("");
      expect(content).toContain("Done after the wait.");
      expect(chunks.filter((c) => c.type === "error")).toEqual([]);
      // Honoured the provider's hint (1.5 s): the generic transient schedule
      // would have retried after ~0.5 s, the rate-limit fallback after ~4 s.
      expect(elapsed).toBeGreaterThanOrEqual(1_450);
      expect(elapsed).toBeLessThan(3_500);
    } finally {
      handle.uninstall();
    }
  }, 20_000);
});
