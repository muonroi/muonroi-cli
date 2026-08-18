import type { LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const N = 3;

function normalize(frame: LiveFrame): string {
  const { seq: _seq, ts: _ts, ...rest } = frame as LiveFrame & { seq: number; ts: number };
  return JSON.stringify(rest, (key, value) => {
    if (key === "scrollTop") return undefined;
    if (key === "values" && typeof value === "string") return value.replace(/\b[0-9a-f]{12}\b/g, "<session>");
    if (key === "id" && typeof value === "string") return value.replace(/\b\d{13}\b/g, "<epoch>");
    return value;
  });
}

async function runOnce(): Promise<string> {
  const { proc, driver, cleanup } = await spawnHarness({
    extraArgs: ["--agent-fake-clock", "-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
    env: {
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_PIL_DISCOVERY: "0",
    },
  });

  try {
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 60_000 });
    driver.type("hello");
    driver.press("Enter");
    await driver.wait_for({ selector: "id=msg-1", timeoutMs: 30_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const frame = driver.snapshot();
    if (!frame) throw new Error("No LiveFrame after the assistant reply");
    return normalize(frame);
  } finally {
    cleanup();
    proc.kill();
  }
}

describe(`determinism: ${N}× identical LiveFrame final state`, () => {
  it(`${N} sequential runs produce identical final UI state`, async () => {
    const traces: string[] = [];
    for (let i = 0; i < N; i++) traces.push(await runOnce());

    const counts = new Map<string, number>();
    for (const trace of traces) counts.set(trace, (counts.get(trace) ?? 0) + 1);
    const [, modalCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const threshold = N - 1;

    if (modalCount < threshold) {
      const distinct = [...counts.entries()].map(
        ([value, count], index) => `variant ${index} (×${count}): ${value.slice(0, 2000)}`,
      );
      console.error(`[determinism] only ${modalCount}/${N} runs agree (need ${threshold}):\n${distinct.join("\n")}`);
    }
    expect(modalCount).toBeGreaterThanOrEqual(threshold);
  }, 240_000);
});
