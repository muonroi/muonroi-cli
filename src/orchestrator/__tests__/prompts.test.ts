import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("prompts.ts limit helpers", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-prompts-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origEnvMaxRounds = process.env.MUONROI_MAX_TOOL_ROUNDS;
  const origEnvHardMax = process.env.MUONROI_HARD_MAX_TOOL_ROUNDS;
  const origEnvLlmCalls = process.env.MUONROI_MAX_LLM_CALLS_PER_TURN;
  const origAgentFirst = process.env.MUONROI_AGENT_FIRST;

  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.MUONROI_MAX_TOOL_ROUNDS;
    delete process.env.MUONROI_HARD_MAX_TOOL_ROUNDS;
    delete process.env.MUONROI_MAX_LLM_CALLS_PER_TURN;
    delete process.env.MUONROI_AGENT_FIRST;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });

    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;

    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;

    if (origEnvMaxRounds === undefined) delete process.env.MUONROI_MAX_TOOL_ROUNDS;
    else process.env.MUONROI_MAX_TOOL_ROUNDS = origEnvMaxRounds;

    if (origEnvHardMax === undefined) delete process.env.MUONROI_HARD_MAX_TOOL_ROUNDS;
    else process.env.MUONROI_HARD_MAX_TOOL_ROUNDS = origEnvHardMax;

    if (origEnvLlmCalls === undefined) delete process.env.MUONROI_MAX_LLM_CALLS_PER_TURN;
    else process.env.MUONROI_MAX_LLM_CALLS_PER_TURN = origEnvLlmCalls;

    if (origAgentFirst === undefined) delete process.env.MUONROI_AGENT_FIRST;
    else process.env.MUONROI_AGENT_FIRST = origAgentFirst;

    vi.resetModules();
  });

  it("loads default limits when agentFirst is false", async () => {
    const dir = path.join(tmpHome, ".muonroi-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "user-settings.json"), JSON.stringify({ agentFirst: false }));

    vi.resetModules();
    const { MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS, MAX_LLM_CALLS_PER_TURN } = await import("../prompts.js");
    expect(MAX_TOOL_ROUNDS).toBe(40);
    expect(HARD_MAX_TOOL_ROUNDS).toBe(60);
    expect(MAX_LLM_CALLS_PER_TURN).toBe(12);
  });

  it("defaults to agentFirst limits (true) when no config is present", async () => {
    vi.resetModules();
    const { MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS, MAX_LLM_CALLS_PER_TURN } = await import("../prompts.js");
    expect(MAX_TOOL_ROUNDS).toBe(200);
    expect(HARD_MAX_TOOL_ROUNDS).toBe(300);
    expect(MAX_LLM_CALLS_PER_TURN).toBe(100);
  });

  it("loads raised limits when agentFirst is true in settings", async () => {
    const dir = path.join(tmpHome, ".muonroi-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "user-settings.json"), JSON.stringify({ agentFirst: true }));

    vi.resetModules();
    const { MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS, MAX_LLM_CALLS_PER_TURN } = await import("../prompts.js");
    expect(MAX_TOOL_ROUNDS).toBe(200);
    expect(HARD_MAX_TOOL_ROUNDS).toBe(300);
    expect(MAX_LLM_CALLS_PER_TURN).toBe(100);
  });

  it("respects env overrides and clamps them (when agentFirst is true by default)", async () => {
    process.env.MUONROI_MAX_TOOL_ROUNDS = "3000"; // Clamped to 2000 in agent-first
    process.env.MUONROI_HARD_MAX_TOOL_ROUNDS = "50";
    process.env.MUONROI_MAX_LLM_CALLS_PER_TURN = "15";

    vi.resetModules();
    const { MAX_TOOL_ROUNDS, HARD_MAX_TOOL_ROUNDS, MAX_LLM_CALLS_PER_TURN } = await import("../prompts.js");
    expect(MAX_TOOL_ROUNDS).toBe(2000);
    expect(HARD_MAX_TOOL_ROUNDS).toBe(50);
    expect(MAX_LLM_CALLS_PER_TURN).toBe(15);
  });
});
