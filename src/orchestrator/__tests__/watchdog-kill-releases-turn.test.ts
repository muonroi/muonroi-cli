import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import type { StreamChunk } from "../../types/index.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";

/**
 * Session 7f24048ad75d (2026-11-09): the top-level turn watchdog killed a turn
 * hung at `mainStream.provider`; after that EVERY message the user typed (21 of
 * them over 32 minutes) died inside `Agent.processMessage` between the
 * `pre-stream.subSessionClassify.start` breadcrumb and its `.end` — the only
 * statement there that can throw is `routingController.signal.throwIfAborted()`,
 * which throws when `this.abortController` is still the controller the watchdog
 * aborted. The killed turn's own `finally` is what normally clears it, and that
 * finally only runs once the hung provider call actually settles.
 *
 * A provider call that ignores the abort signal never settles, so the model here
 * is exactly that: first call hangs forever, later calls answer.
 */

const IDLE_MS = "300";

async function withAgent(
  run: (agent: Agent, calls: { n: number }) => Promise<void>,
  opts: { hangOnCall: number | null; toolFirst?: boolean } = { hangOnCall: 1 },
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-wd-release-"));
  const previousCwd = process.cwd();
  const envKeys = ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL", "MUONROI_TURN_IDLE_MS"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  fs.mkdirSync(path.join(home, ".muonroi-cli"));
  fs.writeFileSync(path.join(home, "evidence.txt"), "verified tool evidence");
  process.chdir(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
  process.env.MUONROI_TURN_IDLE_MS = IDLE_MS;
  closeDatabase();
  await loadCatalog();
  const stallSpy = vi.spyOn(settings, "getProviderStallTimeoutMs").mockReturnValue(60_000);
  const progressSpy = vi.spyOn(settings, "getProviderProgressTimeoutMs").mockReturnValue(60_000);
  const handle = installMockModel({
    fixture: {
      autoClassify: true,
      stream: [
        opts.toolFirst
          ? toolCallStream({
              toolCallId: "evidence-read",
              toolName: "read_file",
              input: { file_path: path.join(home, "evidence.txt") },
            })
          : textOnlyStream("SECOND_ANSWERED"),
        ...(opts.toolFirst ? [textOnlyStream("SECOND_ANSWERED")] : []),
      ],
    },
  });
  const original = handle.model.doStream.bind(handle.model);
  const calls = { n: 0 };
  const doStreamSpy = vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
    if (!options.tools?.length) return original(options);
    calls.n++;
    if (opts.hangOnCall === calls.n) return await new Promise<never>(() => {});
    return original(options);
  });
  try {
    const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 2, {
      persistSession: true,
      executionRole: "orchestrator",
    });
    await agent.setPermissionModeFromUser("auto-edit");
    await run(agent, calls);
  } finally {
    doStreamSpy.mockRestore();
    stallSpy.mockRestore();
    progressSpy.mockRestore();
    handle.uninstall();
    closeDatabase();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function drain(agent: Agent, message: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of agent.processMessage(message)) chunks.push(c);
  return chunks;
}

const text = (chunks: StreamChunk[]) =>
  chunks
    .filter((c) => c.type === "content")
    .map((c) => c.content)
    .join("");

describe("watchdog kill releases the turn", () => {
  it("leaves no aborted controller behind and the next message starts a turn", async () => {
    await withAgent(async (agent) => {
      const first = await drain(agent, "hello, first message");
      expect(first.filter((c) => c.type === "error").map((c) => c.content)).toEqual([
        expect.stringContaining("Turn ended by watchdog"),
      ]);
      // The hung provider call never settles, so the killed turn's own finally never ran.
      expect((agent as unknown as { abortController: AbortController | null }).abortController).toBeNull();

      const second = await drain(agent, "second message after the kill");
      expect(text(second)).toContain("SECOND_ANSWERED");
    });
  }, 20_000);

  it("hands back steering messages drained into the killed request", async () => {
    await withAgent(
      async (agent) => {
        const restored: string[][] = [];
        agent.setSteerDrain(() => [{ text: "typed while it was stuck" }]);
        agent.setSteerRestore((texts) => restored.push(texts));
        const first = await drain(agent, "hello, first message");
        expect(first.some((c) => c.type === "error")).toBe(true);
        expect(restored).toEqual([["typed while it was stuck"]]);
      },
      { hangOnCall: 2, toolFirst: true },
    );
  }, 20_000);

  it("does not hand back steering when the turn finished normally", async () => {
    await withAgent(
      async (agent) => {
        const restored: string[][] = [];
        agent.setSteerDrain(() => []);
        agent.setSteerRestore((texts) => restored.push(texts));
        await drain(agent, "hello");
        expect(restored).toEqual([]);
      },
      { hangOnCall: null },
    );
  }, 20_000);
});
