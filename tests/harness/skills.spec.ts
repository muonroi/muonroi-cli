/**
 * tests/harness/skills.spec.ts — Agent Skills, driven as a user through the real TUI.
 *
 *   (a) `/skills` lists a seeded project skill (and `/skills` was "Unknown command"
 *       before — removed in 8d3a7f77).
 *   (b) the model calls `skill_load` and the SKILL.md body reaches the NEXT model
 *       call (recorded prompt); `/skill <name> args` and `/<name>` put the body
 *       into the user turn.
 *   (c) `/skill-create` asks name / description / scope on askcards, writes a
 *       valid SKILL.md, and `/skills` lists it without a restart.
 *   (d) the model-callable `skill_create` writes a skill that is loadable and
 *       indexed in the same session.
 *
 * Main's turns are scripted through a `routes` entry keyed on the orchestrator
 * contract, so ancillary calls (classifier, title) never consume a round.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { ORCHESTRATOR_ROLE_PREFIX } from "../../src/orchestrator/orchestration-policy.js";
import { makeTextStream } from "./cost-leak-tui-helpers.js";
import { type HarnessContext, spawnHarness } from "./helpers.js";
import { type InspectedCall, loadDumpedRecordings } from "./recording.js";

const SEEDED_SKILL = [
  "---",
  "name: release-check",
  "description: Pre-release checklist for this repo. Use before any release.",
  "---",
  "",
  "# Release check",
  "",
  "MARKER-BODY-7731: run the smoke suite for $ARGUMENTS first.",
  "",
].join("\n");

function toolCallStream(id: string, toolName: string, input: Record<string, unknown>): unknown[] {
  const json = JSON.stringify(input);
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: json },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input: json },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: null },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: null, cacheWrite: null },
        outputTokens: { total: 10, text: 10, reasoning: null },
      },
    },
  ];
}

interface SkillsHarness extends HarnessContext {
  workDir: string;
  project: string;
  cliHome: string;
  dumpPath: string;
}

async function spawnSkillsHarness(mainRounds: unknown[][]): Promise<SkillsHarness> {
  const workDir = mkdtempSync(join(tmpdir(), "muonroi-skills-e2e-"));
  const project = join(workDir, "project");
  const cliHome = join(workDir, "cli-home");
  const fixDir = join(workDir, "fix");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, ".agents", "skills", "release-check"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "release-check", "SKILL.md"), SEEDED_SKILL, "utf8");
  writeFileSync(join(project, "README.md"), "fixture\n", "utf8");
  mkdirSync(fixDir);
  writeFileSync(
    join(fixDir, "fixture.json"),
    JSON.stringify({
      responses: [{ match: "*", text: "ok" }],
      model: {
        stream: makeTextStream("fallback"),
        routes: [{ systemIncludes: ORCHESTRATOR_ROLE_PREFIX, stream: mainRounds }],
      },
    }),
    "utf8",
  );
  const dumpPath = join(workDir, "calls.json");
  const ctx = await spawnHarness({
    cwd: project,
    fixturesDir: fixDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--permission", "auto-edit"],
    env: {
      MUONROI_CLI_HOME: cliHome,
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
    },
  });
  await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  return { ...ctx, workDir, project, cliHome, dumpPath };
}

function mainCalls(dumpPath: string): InspectedCall[] {
  if (!existsSync(dumpPath)) return [];
  return loadDumpedRecordings(dumpPath).filter((c) => c.systemText.includes(ORCHESTRATOR_ROLE_PREFIX));
}

function promptText(call: InspectedCall): string {
  return JSON.stringify(call.options.prompt);
}

function toolNames(call: InspectedCall): string[] {
  return ((call.options.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
}

const TRANSCRIPT_ENTRY = 'id*="^msg-\\d+$"';

/**
 * Type + Enter, then wait until the transcript grows (every command here adds
 * an entry). Not gated on the composer's `value` mirror: measured with a probe
 * in this suite, after the first model turn that mirror stays "" while typed
 * keys DO reach the textarea.
 *
 * One bounded re-press: with temporary key tracing in handleKey, an Enter sent
 * after typing occasionally never reached the app key handler at all while the
 * typed text sat in the composer. A probe with no skill code (six `/help` in a
 * row) lost the sixth Enter the same way once the transcript overflowed, so it
 * is a harness/TUI delivery loss, not this feature. The retry is logged.
 */
async function submit(driver: Driver, text: string): Promise<void> {
  const before = driver.count(TRANSCRIPT_ENTRY);
  driver.type(text);
  await new Promise((r) => setTimeout(r, 700));
  driver.press("Enter");
  const grew = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (driver.count(TRANSCRIPT_ENTRY) > before) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (await grew(5_000)) return;
  console.warn(`[skills.spec] Enter for "${text}" was not observed in 5s; pressing Enter once more`);
  driver.press("Enter");
  if (!(await grew(15_000))) throw new Error(`"${text}" + Enter never reached the transcript\n${driver.render_text()}`);
}

/**
 * Poll the transcript entries' semantic names (each carries the entry's first
 * 40 chars). Used instead of the visual frame for content checks: measured in
 * this suite, the visual stream stayed on the splash frame for 15s+ after the
 * first command (even after a repaint nudge) while the semantic tree held the
 * new entry.
 */
async function waitEntry(h: SkillsHarness, match: (name: string) => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (h.driver.queryAll(TRANSCRIPT_ENTRY).some((n) => match(String(n.name ?? "")))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: no matching transcript entry\n${h.driver.render_text()}`);
}

/** Wait for a transcript entry whose text starts with `text` (semantic tree; names carry 40 chars). */
async function waitMessage(h: SkillsHarness, text: string, timeoutMs: number): Promise<void> {
  try {
    await h.driver.wait_for({ selector: `role=listitem name~="${text.slice(0, 30)}"`, timeoutMs });
  } catch (err) {
    const calls = mainCalls(h.dumpPath);
    const tail = calls.length ? promptText(calls.at(-1)!).slice(-1500) : "(no main calls)";
    throw new Error(
      `message "${text}" never appeared: ${String(err)}\nmain calls=${calls.length}\nlast prompt tail=${tail}\nTREE:\n${h.driver.render_text()}`,
    );
  }
}

/** Answer the currently open free-text ask_user card. */
async function answerFreeText(driver: Driver, question: string, answer: string): Promise<void> {
  try {
    await driver.wait_for({
      event: "askcard-open",
      match: (e) => e.kind === "askcard-open" && e.question === question,
      timeoutMs: 15_000,
    });
  } catch (err) {
    throw new Error(
      `askcard "${question}" never opened: ${String(err)}\nlast askcard-open=${JSON.stringify(driver.last_event("askcard-open"))}\n${driver.render_text()}\n${driver.render_visual()}`,
    );
  }
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      throw new Error(`askcard "${question}" step ${label}: ${String(err)}\n${driver.render_text()}`);
    }
  };
  await step("card", () => driver.wait_for({ selector: "id=askcard", timeoutMs: 5_000 }));
  // Open the free-text field.
  await step("input", () => pressUntil(driver, "Enter", () => driver.query("id=askcard-input") !== null, "open input"));
  driver.type(answer);
  await step("typed", () => driver.wait_for({ selector: `id=askcard-input value="${answer}"`, timeoutMs: 5_000 }));
  await step("answered", () =>
    pressUntil(
      driver,
      "Enter",
      () => (driver.last_event("askcard-answered") as { answerText?: string } | undefined)?.answerText === answer,
      "submit answer",
    ),
  );
}

/**
 * Press `key` until `done()` holds: one settle, one press, one bounded re-press.
 * See submit() for the measured key-delivery loss this absorbs; retries are logged.
 */
async function pressUntil(driver: Driver, key: string, done: () => boolean, label: string): Promise<void> {
  const until = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (done()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  await new Promise((r) => setTimeout(r, 300));
  driver.press(key);
  if (await until(4_000)) return;
  console.warn(`[skills.spec] ${key} (${label}) not observed in 4s; pressing once more`);
  driver.press(key);
  if (!(await until(10_000))) throw new Error(`${key} (${label}) had no effect after a re-press`);
}

/**
 * One TUI per scenario, on purpose: measured with a probe (six `/help` in a row,
 * no skill code involved), once the transcript overflows the viewport the
 * sixth Enter never reaches the app key handler. Short sessions keep every
 * scenario below that pre-existing input-loss threshold.
 */
function useSession(mainRounds: unknown[][]): () => SkillsHarness {
  let h: SkillsHarness | undefined;
  beforeAll(async () => {
    h = await spawnSkillsHarness(mainRounds);
  }, 180_000);
  afterAll(() => {
    h?.proc.kill();
    h?.cleanup();
    if (h) bestEffortRemoveSync(h.workDir, "tests/harness/skills.spec.ts");
  });
  return () => {
    if (!h) throw new Error("skills harness failed to spawn");
    return h;
  };
}

describe("skills E2E — /skills, /skill <name>, /<name>", () => {
  const session = useSession([makeTextStream("Skill run acknowledged."), makeTextStream("Direct run acknowledged.")]);

  it("(a) /skills lists the seeded project skill (project skills first)", async () => {
    const h = session();
    await submit(h.driver, "/skills");
    // Entry names carry the first 40 chars: "assistant:Agent Skills (2)\n\n- release-ch".
    await waitEntry(h, (name) => name.includes("Agent Skills (2)") && name.includes("- release-ch"), "/skills listing");
    expect(h.driver.query('role=toast name~="Unknown command"')).toBeNull();
  }, 60_000);

  it("(b) /skill <name> args and /<name> put the rendered SKILL.md body into the user turn", async () => {
    const h = session();
    await submit(h.driver, "/skill release-check v2.1");
    await waitMessage(h, "Skill run acknowledged.", 30_000);
    // Read the dump only after the turn: the child rewrites it by rename, which
    // Windows refuses while the parent has it open, so tight polling starves it.
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(1);
    const first = promptText(mainCalls(h.dumpPath)[0]!);
    expect(first).toContain("MARKER-BODY-7731: run the smoke suite for v2.1 first.");
    expect(first).toContain('The user invoked the skill \\"release-check\\" with arguments: v2.1');

    await submit(h.driver, "/release-check");
    await waitMessage(h, "Direct run acknowledged.", 30_000);
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(2);
    const second = promptText(mainCalls(h.dumpPath).at(-1)!);
    expect(second).toContain("MARKER-BODY-7731");
  }, 120_000);
});

describe("skills E2E — /skill-create with arguments", () => {
  const session = useSession([makeTextStream("Notes run acknowledged.")]);

  it("(c2) writes a user-scope skill without asking; /skills and /skill see it without a restart", async () => {
    const h = session();
    await submit(h.driver, "/skill-create notes-digest --user Summarise meeting notes into actions.");
    const target = join(h.cliHome, "skills", "notes-digest", "SKILL.md");
    await expect.poll(() => existsSync(target), { timeout: 10_000 }).toBe(true);
    expect(readFileSync(target, "utf8")).toMatch(
      /^---\nname: notes-digest\ndescription: "Summarise meeting notes into actions\."\n---\n/,
    );
    expect(h.driver.query("id=askcard")).toBeNull();
    await submit(h.driver, "/skills");
    await waitEntry(h, (name) => name.includes("Agent Skills (3)"), "/skills listing with the new skill");

    await submit(h.driver, "/skill notes-digest");
    await waitMessage(h, "Notes run acknowledged.", 30_000);
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(1);
    expect(promptText(mainCalls(h.dumpPath)[0]!)).toContain("Summarise meeting notes into actions.");
  }, 120_000);
});

describe("skills E2E — /skill-create interactive", () => {
  const session = useSession([makeTextStream("Triage run acknowledged.")]);

  it("(c) asks name, description and scope on askcards, writes SKILL.md, and the skill is usable at once", async () => {
    const h = session();
    await submit(h.driver, "/skill-create");
    await answerFreeText(h.driver, "Skill name?", "triage-bugs");
    await answerFreeText(
      h.driver,
      'What does "triage-bugs" do, and when should it be used?',
      "Triage incoming bug reports. Use when a new issue arrives.",
    );
    await h.driver.wait_for({
      event: "askcard-open",
      match: (e) => e.kind === "askcard-open" && e.question === 'Where should "triage-bugs" live?',
      timeoutMs: 15_000,
    });
    await h.driver.wait_for({ selector: "id=askcard-option-project selected", timeoutMs: 5_000 });
    const target = join(h.project, ".agents", "skills", "triage-bugs", "SKILL.md");
    await pressUntil(h.driver, "Enter", () => existsSync(target), "pick project scope");
    expect(readFileSync(target, "utf8")).toMatch(
      /^---\nname: triage-bugs\ndescription: "Triage incoming bug reports\. Use when a new issue arrives\."\n---\n/,
    );
    await waitMessage(h, "Created skill", 10_000);

    await submit(h.driver, "/skills");
    await waitEntry(h, (name) => name.includes("Agent Skills (3)"), "/skills listing with the new skill");

    await submit(h.driver, "/triage-bugs new crash report");
    await waitMessage(h, "Triage run acknowledged.", 30_000);
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(1);
    const turn = promptText(mainCalls(h.dumpPath)[0]!);
    expect(turn).toContain("Triage incoming bug reports. Use when a new issue arrives.");
    expect(turn).toContain("new crash report");
  }, 150_000);
});

describe("skills E2E — model tools", () => {
  let h: SkillsHarness;

  beforeAll(async () => {
    h = await spawnSkillsHarness([
      toolCallStream("load-1", "skill_load", { name: "release-check", arguments: "v9" }),
      makeTextStream("Loaded the release check."),
      toolCallStream("create-1", "skill_create", {
        name: "tool-made",
        description: "Made by the model. Use when testing skill_create.",
        scope: "project",
        instructions: "# Tool made\n\nMARKER-TOOL-42 do the thing.",
      }),
      makeTextStream("Created it."),
      toolCallStream("load-2", "skill_load", { name: "tool-made" }),
      makeTextStream("Loaded the new skill."),
    ]);
  }, 180_000);

  afterAll(() => {
    h?.proc.kill();
    h?.cleanup();
    if (h) bestEffortRemoveSync(h.workDir, "tests/harness/skills.spec.ts");
  });

  it("(b) main sees a bounded index, calls skill_load, and the body reaches the next model call", async () => {
    await submit(h.driver, "check the release");
    await waitMessage(h, "Loaded the release check.", 45_000);
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(2);
    const calls = mainCalls(h.dumpPath);
    expect(calls[0]!.systemText).toContain("- release-check: Pre-release checklist for this repo.");
    expect(toolNames(calls[0]!)).toEqual(expect.arrayContaining(["skill_load", "skill_create"]));
    expect(promptText(calls[0]!)).not.toContain("MARKER-BODY-7731");
    expect(promptText(calls[1]!)).toContain("MARKER-BODY-7731: run the smoke suite for v9 first.");
  }, 90_000);

  it("(d) skill_create writes a valid SKILL.md that is indexed and loadable in the same session", async () => {
    await submit(h.driver, "make a skill for this");
    await waitMessage(h, "Created it.", 45_000);
    const target = join(h.project, ".agents", "skills", "tool-made", "SKILL.md");
    expect(existsSync(target)).toBe(true);
    const md = readFileSync(target, "utf8");
    expect(md).toMatch(
      /^---\nname: tool-made\ndescription: "Made by the model\. Use when testing skill_create\."\n---\n/,
    );
    expect(md).toContain("MARKER-TOOL-42");

    await submit(h.driver, "use the new skill");
    await waitMessage(h, "Loaded the new skill.", 45_000);
    // Turns 1-2 made 4 main calls; this turn adds the load call and the reply.
    await expect
      .poll(() => mainCalls(h.dumpPath).length, { timeout: 30_000, interval: 1_000 })
      .toBeGreaterThanOrEqual(6);
    const calls = mainCalls(h.dumpPath);
    const loadCall = calls.at(-2)!;
    expect(loadCall.systemText).toContain("- tool-made: Made by the model.");
    expect(promptText(calls.at(-1)!)).toContain("MARKER-TOOL-42 do the thing.");
  }, 120_000);
});
