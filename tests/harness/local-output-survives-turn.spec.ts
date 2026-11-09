/**
 * tests/harness/local-output-survives-turn.spec.ts
 *
 * Host-local command output (`/help`, `/skills`, …: rendered by the TUI without
 * a model call) must still be on screen after the next model turn.
 *
 * Root cause (src/ui/use-app-logic.tsx finalizeActiveTurn): at the end of a
 * local turn the transcript is REBUILT from saved history
 * (`agent.getChatEntries()`), and local output was never saved, so the rebuild
 * dropped it. The same rebuild also paired the n-th saved user message with the
 * n-th on-screen user entry, so a local `/ideal <x>` echo would have lent its
 * text to the model prompt's entry.
 *
 * Gate: after `/help` + `/skills` and one scripted model turn, both outputs are
 * still rendered, in order, ABOVE the model turn, and no recorded model call
 * carries any of that text.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type CostLeakHarness, makeTextStream, spawnCostLeakHarness } from "./cost-leak-tui-helpers.js";
import { loadDumpedRecordings } from "./recording.js";

const FINAL = "LOCAL_OUTPUT_TURN_DONE_41f9";
const PROMPT = "reply with the marker please";
// One line of the /help listing (VISIBLE_SLASH_MENU_ITEMS) and one of the /skills listing (utils/skills.ts).
const SKILLS_LINE = "Create: /skill-create [name]";
const HELP_LINE = "/council — Start a background council; results appear in jobs";

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe("local command output survives the next model turn", { retry: 0 }, () => {
  let handle: CostLeakHarness | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("/help output is still rendered after a model turn and never reaches the model", async () => {
    handle = await spawnCostLeakHarness(
      { provider: "deepseek", modelId: "deepseek-v4-flash", stream: [makeTextStream(FINAL)] },
      { permission: "auto-edit", isolatedCwd: true },
    );
    const { driver } = handle;
    const screen = () => driver.render_visual();
    const submit = async (text: string) => {
      driver.type(text);
      expect(await until(() => driver.query("id=composer")?.value === text, 10_000)).toBe(true);
      driver.press("Enter");
    };

    await submit("/help");
    expect(await until(() => screen().includes(HELP_LINE), 20_000), screen()).toBe(true);

    await submit(PROMPT);
    expect(await until(() => screen().includes(FINAL), 30_000), screen()).toBe(true);
    // The turn is over (and the end-of-turn transcript refresh has run) once
    // the composer stops offering to queue a follow-up.
    expect(await until(() => !screen().includes("Queue a follow-up"), 30_000), screen()).toBe(true);

    const after = screen();
    expect(after, "the /help output vanished at the end of the model turn").toContain(HELP_LINE);
    // Chronological order: /help came before the prompt, the answer after it.
    expect(after.indexOf(HELP_LINE)).toBeLessThan(after.indexOf(FINAL));

    // The model saw the prompt, not the host's local output.
    expect(await until(() => existsSync(handle!.dumpPath), 15_000)).toBe(true);
    const calls = loadDumpedRecordings(handle.dumpPath);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const everything = `${call.systemText}\n${call.userText}\n${call.assistantText}`;
      expect(everything).not.toContain(HELP_LINE);
    }
    expect(calls.map((c) => c.userText).join("\n")).toContain(PROMPT);
  }, 180_000);

  it("a registry slash (/skills) output also survives the next model turn", async () => {
    handle = await spawnCostLeakHarness(
      { provider: "deepseek", modelId: "deepseek-v4-flash", stream: [makeTextStream(FINAL)] },
      { permission: "auto-edit", isolatedCwd: true },
    );
    const { driver } = handle;
    const screen = () => driver.render_visual();
    const submit = async (text: string) => {
      driver.type(text);
      expect(await until(() => driver.query("id=composer")?.value === text, 10_000)).toBe(true);
      driver.press("Enter");
    };

    await submit("/skills");
    expect(await until(() => screen().includes(SKILLS_LINE), 20_000), screen()).toBe(true);

    await submit(PROMPT);
    expect(await until(() => screen().includes(FINAL), 30_000), screen()).toBe(true);
    expect(await until(() => !screen().includes("Queue a follow-up"), 30_000), screen()).toBe(true);
    expect(screen(), "the /skills output vanished at the end of the model turn").toContain(SKILLS_LINE);

    expect(await until(() => existsSync(handle!.dumpPath), 15_000)).toBe(true);
    for (const call of loadDumpedRecordings(handle.dumpPath)) {
      expect(`${call.systemText}\n${call.userText}\n${call.assistantText}`).not.toContain(SKILLS_LINE);
    }
  }, 180_000);
});
