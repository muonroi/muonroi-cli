/**
 * tests/harness/safe-mode-tool-approval.spec.ts
 *
 * In `safe` permission mode the orchestrator's own read_file/grep ask the user
 * before they run (src/orchestrator/tool-engine.ts). This spec drives that
 * approval card end-to-end through the real TUI with a scripted mock model and
 * asserts what the MODEL sees afterwards:
 *
 *   approve → the read_file call executes, its tool-result (with the file
 *             content) is in the very next model call, and the turn finishes
 *             with the model's final text.
 *   deny    → the call is answered with a tool-result that says it was denied
 *             (no file content), and the model still gets to finish the turn.
 *
 * In both paths no synthetic user message (the legacy "[Payment approved]") may
 * be injected into the history, and every tool-call the model sees must have a
 * matching tool-result — OpenAI-compatible providers 400 on a dangling call.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CostLeakHarness, exitTuiAndWaitForDump, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { type InspectedCall, isMainAgentCall, loadDumpedRecordings } from "./recording.js";

const SAMPLE_REL = "tests/harness/fixtures/safe-mode-approval/sample.txt";
const MARKER = "SAFE_MODE_APPROVAL_MARKER_7f3a";
const CALL_ID = "safe-read-1";
const FINAL_TEXT = "APPROVAL_FLOW_FINAL_ANSWER";
const PROMPT = "show me the approval sample file contents";

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
};

const readRound = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: CALL_ID, toolName: "read_file", input: JSON.stringify({ file_path: SAMPLE_REL }) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
];
const finalRound = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "final" },
  { type: "text-delta", id: "final", delta: FINAL_TEXT },
  { type: "text-end", id: "final" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];

type PromptPart = { type: string; toolCallId?: string; output?: unknown; text?: string };
type PromptMessage = { role: string; content: string | PromptPart[] };

function messagesOf(call: InspectedCall): PromptMessage[] {
  return call.options.prompt as unknown as PromptMessage[];
}

function partsOf(call: InspectedCall, type: string): PromptPart[] {
  return messagesOf(call).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === type) : []));
}

function resultFor(call: InspectedCall, id: string): PromptPart | undefined {
  return partsOf(call, "tool-result").find((p) => p.toolCallId === id);
}

function readMainCalls(dumpPath: string): InspectedCall[] {
  try {
    return loadDumpedRecordings(dumpPath).filter(isMainAgentCall);
  } catch (err) {
    // The child rewrites the dump atomically after every call; before the
    // first call there is simply no file yet. Report and keep polling.
    console.warn(`[safe-mode-approval spec] dump not readable yet: ${(err as Error).message}`);
    return [];
  }
}

async function waitForResultCall(dumpPath: string, timeoutMs: number): Promise<InspectedCall | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readMainCalls(dumpPath).find((c) => resultFor(c, CALL_ID));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

async function waitForRendered(handle: CostLeakHarness, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.driver.render_text().includes(text)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function driveToApprovalCard(): Promise<CostLeakHarness> {
  process.env.MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS = "1000000";
  process.env.MUONROI_CROSS_TURN_DEDUP = "0";
  const handle = await spawnCostLeakHarness(
    { provider: "deepseek", modelId: "deepseek-v4-flash", stream: [readRound, finalRound] },
    { permission: "safe" },
  );
  handle.driver.type(PROMPT);
  await handle.driver.wait_for({ selector: `id=composer value="${PROMPT}"`, timeoutMs: 15_000 });
  handle.driver.press("Enter");
  // Gate keys on the card OWNING the keyboard, not just being in the tree.
  await handle.driver.wait_for({ selector: 'id=payment-approval focus value="Allow once"', timeoutMs: 30_000 });
  return handle;
}

/** Compact, system-prompt-free view of EVERY recorded call — the failure evidence. */
function summarize(dumpPath: string): string {
  let all: InspectedCall[];
  try {
    all = loadDumpedRecordings(dumpPath);
  } catch (err) {
    return `(no dump: ${(err as Error).message})`;
  }
  return all
    .map((c) => {
      const msgs = messagesOf(c)
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (typeof m.content === "string") return `${m.role}:${m.content.slice(0, 80)}`;
          const parts = m.content.map((p) =>
            p.type === "text"
              ? `text(${(p.text ?? "").slice(0, 60)})`
              : `${p.type}(${p.toolCallId ?? ""}${p.output ? ` ${JSON.stringify(p.output).slice(0, 80)}` : ""})`,
          );
          return `${m.role}:[${parts.join(", ")}]`;
        });
      const sys = c.systemText.slice(0, 40).replace(/\s+/g, " ");
      return `#${c.index} main=${isMainAgentCall(c)} sys=${sys} | ${msgs.join(" | ")}`;
    })
    .join("\n");
}

/** Every tool-call the model is shown must carry a tool-result in the same prompt. */
function danglingCalls(call: InspectedCall): string[] {
  const results = new Set(partsOf(call, "tool-result").map((p) => p.toolCallId));
  return partsOf(call, "tool-call")
    .map((p) => p.toolCallId ?? "")
    .filter((id) => !results.has(id));
}

describe("safe mode: orchestrator read_file approval continues the same turn", () => {
  let handle: CostLeakHarness | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("approve → read_file executes, its result reaches the model, the turn finishes", async () => {
    handle = await driveToApprovalCard();
    const cardName = handle.driver.query("id=payment-approval")?.name;
    handle.driver.press("Enter"); // option 0 = allow

    const resultCall = await waitForResultCall(handle.dumpPath, 45_000);
    const finished = await waitForRendered(handle, FINAL_TEXT, 30_000);
    await exitTuiAndWaitForDump(handle, 20_000);
    const calls = readMainCalls(handle.dumpPath);
    const dump = summarize(handle.dumpPath);

    expect(resultCall, `no main call carried a tool-result for ${CALL_ID}\n${dump}`).toBeDefined();
    expect(JSON.stringify(resultFor(resultCall!, CALL_ID)?.output)).toContain(MARKER);
    expect(finished, "the model's final answer never rendered").toBe(true);
    for (const c of calls) {
      expect(c.userText).not.toContain("[Payment approved]");
      expect(danglingCalls(c), `dangling tool-call in call #${c.index}`).toEqual([]);
    }
    // The card is a tool approval, not the long-removed x402 payment prompt.
    expect(cardName).toMatch(/tool approval/i);
    // Sanity: the marker really comes from the file on disk, not the fixture.
    expect(readFileSync(resolve(SAMPLE_REL), "utf8")).toContain(MARKER);
  }, 180_000);

  it("deny → a denied tool-result reaches the model (no file content) and the turn finishes", async () => {
    handle = await driveToApprovalCard();
    handle.driver.press("Down"); // option 1 = deny
    // The Enter handler reads the RENDERED selection; pressing it before the
    // Down re-render lands approves instead (measured: 1 of 3 runs read the file).
    await handle.driver.wait_for({ selector: 'id=payment-approval value="Deny"', timeoutMs: 10_000 });
    handle.driver.press("Enter");

    const resultCall = await waitForResultCall(handle.dumpPath, 45_000);
    const finished = await waitForRendered(handle, FINAL_TEXT, 30_000);
    await exitTuiAndWaitForDump(handle, 20_000);
    const calls = readMainCalls(handle.dumpPath);
    const dump = summarize(handle.dumpPath);

    expect(resultCall, `no main call carried a tool-result for ${CALL_ID}\n${dump}`).toBeDefined();
    const output = JSON.stringify(resultFor(resultCall!, CALL_ID)?.output);
    expect(output).not.toContain(MARKER);
    expect(output).toMatch(/denied/i);
    expect(finished, "the model's final answer never rendered").toBe(true);
    for (const c of calls) {
      expect(c.userText).not.toContain("[Payment approved]");
      expect(danglingCalls(c), `dangling tool-call in call #${c.index}`).toEqual([]);
    }
  }, 180_000);
});
