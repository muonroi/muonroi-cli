/**
 * Tests for P3.3 + P3.4 + P3.6:
 *   - recordVerifyFailureAndMaybePush threshold logic
 *   - pushFailureToEE payload shape
 *   - one-shot push per signature crossing threshold
 *   - independent signatures each trigger their own push
 *   - P3.6: logInteraction called once when count crosses 3
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultEEClient } from "../../ee/intercept.js";
import type { PostToolPayload } from "../../ee/types.js";
import { pushFailureToEE, recordVerifyFailureAndMaybePush } from "../verify-failure-tracking.js";

// P3.6: mock storage to capture logInteraction calls
vi.mock("../../storage/index.js", () => ({
  logInteraction: vi.fn(),
}));

import { logInteraction } from "../../storage/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let flowDir: string;
const runId = "run-threshold-test";
const sessionId = "test-session-id";
const cwd = "/fake/cwd";

const BASE_INPUT = {
  errorMessage: "TypeError: Cannot read property 'x' of undefined\n    at doThing (src/foo.ts:42:7)",
  verifyCommand: "bun test",
  fileTouched: "src/foo.ts",
};

/** Build a minimal mock EE client that records posttool calls */
function makeMockClient() {
  const calls: PostToolPayload[] = [];
  const client = {
    intercept: vi.fn(),
    posttool: vi.fn(async (payload: PostToolPayload) => {
      calls.push(payload);
    }),
    routeModel: vi.fn(),
  } as unknown as ReturnType<typeof import("../../ee/client.js").createEEClient>;
  return { client, calls };
}

beforeEach(async () => {
  flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "vft-threshold-"));
});

afterEach(async () => {
  // Windows ENOTEMPTY guard — see plan.test.ts:33 for rationale.
  await fs.rm(flowDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  vi.restoreAllMocks();
  vi.mocked(logInteraction).mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("recordVerifyFailureAndMaybePush — threshold", () => {
  it("1. increment twice → no EE push", async () => {
    const { client, calls } = makeMockClient();
    setDefaultEEClient(client);

    await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });
    await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });

    expect(calls).toHaveLength(0);
  });

  it("2. increment to 3 → exactly 1 EE push with toolName='ideal_verify_fail'", async () => {
    const { client, calls } = makeMockClient();
    setDefaultEEClient(client);

    await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });
    await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });
    await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });

    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("ideal_verify_fail");
    expect((calls[0].toolInput as Record<string, unknown>).verifyCommand).toBe(BASE_INPUT.verifyCommand);
    expect((calls[0].toolInput as Record<string, unknown>).signature).toMatch(/^[0-9a-f]{16}$/);
    expect((calls[0].toolInput as Record<string, unknown>).count).toBe(3);
  });

  it("3. increment 4th time → no additional push (one-shot per threshold crossing)", async () => {
    const { client, calls } = makeMockClient();
    setDefaultEEClient(client);

    for (let i = 0; i < 4; i++) {
      await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...BASE_INPUT });
    }

    expect(calls).toHaveLength(1);
  });

  it("P3.6: logInteraction called once when count crosses 3", async () => {
    const { client } = makeMockClient();
    setDefaultEEClient(client);

    // First two calls — no log
    await recordVerifyFailureAndMaybePush({ flowDir, runId, sessionId, cwd, ...BASE_INPUT });
    await recordVerifyFailureAndMaybePush({ flowDir, runId, sessionId, cwd, ...BASE_INPUT });
    expect(vi.mocked(logInteraction)).not.toHaveBeenCalled();

    // Third call — should log with chat session id (FK-safe)
    await recordVerifyFailureAndMaybePush({ flowDir, runId, sessionId, cwd, ...BASE_INPUT });
    expect(vi.mocked(logInteraction)).toHaveBeenCalledOnce();

    const [calledRunId, calledEventType, calledMeta] = vi.mocked(logInteraction).mock.calls[0];
    expect(calledRunId).toBe(sessionId);
    expect(calledEventType).toBe("ee_judge");
    expect(calledMeta?.eventSubtype).toBe("ideal_verify_pattern");
    expect((calledMeta?.data as Record<string, unknown>)?.count).toBe(3);
    expect(typeof (calledMeta?.data as Record<string, unknown>)?.signature).toBe("string");

    // Fourth call — no additional log (one-shot)
    await recordVerifyFailureAndMaybePush({ flowDir, runId, sessionId, cwd, ...BASE_INPUT });
    expect(vi.mocked(logInteraction)).toHaveBeenCalledOnce();
  });

  it("4. two different signatures both reach 3 → 2 pushes", async () => {
    const { client, calls } = makeMockClient();
    setDefaultEEClient(client);

    const inputA = { ...BASE_INPUT, fileTouched: "src/foo.ts" };
    const inputB = { ...BASE_INPUT, fileTouched: "src/bar.ts" };

    // Interleave two different signatures
    for (let i = 0; i < 3; i++) {
      await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...inputA });
      await recordVerifyFailureAndMaybePush({ flowDir, runId, cwd, ...inputB });
    }

    expect(calls).toHaveLength(2);
    const toolNames = calls.map((c) => c.toolName);
    expect(toolNames).toEqual(["ideal_verify_fail", "ideal_verify_fail"]);

    // The two pushes must carry different signatures
    const sigs = calls.map((c) => (c.toolInput as Record<string, unknown>).signature as string);
    expect(sigs[0]).not.toBe(sigs[1]);
  });
});

describe("pushFailureToEE — payload shape", () => {
  it("5. calls posttool with correct shape and outcome.success=false", async () => {
    const { client, calls } = makeMockClient();
    setDefaultEEClient(client);

    await pushFailureToEE({
      signature: "abc123def456ab12",
      count: 3,
      lastError: "Test failed: expected 1 but got 2",
      fileTouched: "src/utils.ts",
      verifyCommand: "bun test --run",
      runId: "run-push-test",
      cwd,
    });

    expect(calls).toHaveLength(1);
    const payload = calls[0];
    expect(payload.toolName).toBe("ideal_verify_fail");
    expect(payload.outcome.success).toBe(false);
    expect(payload.cwd).toBe(cwd);
    expect(payload.tenantId).toBeDefined();
    expect(payload.scope).toBeDefined();
    expect(payload.scope.kind).toMatch(/^(global|repo|branch|ecosystem)$/);
    const input = payload.toolInput as Record<string, unknown>;
    expect(input.signature).toBe("abc123def456ab12");
    expect(input.count).toBe(3);
    expect(input.fileTouched).toBe("src/utils.ts");
    expect(input.verifyCommand).toBe("bun test --run");
  });
});
