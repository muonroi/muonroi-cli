import { describe, expect, it } from "vitest";
import {
  buildBackgroundWakePrompt,
  buildRateLimitRule,
  formatBackgroundProcessStarted,
  formatDelegationStarted,
  isBackgroundAutoWakeEnabled,
  longestSleepSeconds,
  maxParallelBackgroundAgents,
  parallelLimitRefusal,
  parseBackgroundProcessStarted,
  parseDelegationStartedId,
  providerCapacityNote,
  UNDECLARED_MAX_PARALLEL_AGENTS,
} from "../background-jobs.js";

describe("started-line round trip", () => {
  it("recovers a delegation id from the line the tool returned", () => {
    expect(parseDelegationStartedId(`${formatDelegationStarted("calm-teal-owl")}\nAgent: explore`)).toBe(
      "calm-teal-owl",
    );
    expect(parseDelegationStartedId("Delegation finished")).toBeNull();
    expect(parseDelegationStartedId(undefined)).toBeNull();
  });

  it("recovers a background process id and pid", () => {
    expect(parseBackgroundProcessStarted(`${formatBackgroundProcessStarted(12, 3456)}\nCommand: x`)).toEqual({
      id: 12,
      pid: 3456,
    });
    expect(parseBackgroundProcessStarted("ok")).toBeNull();
  });
});

describe("longestSleepSeconds", () => {
  it.each([
    ["sleep 120; cat results.txt", 120],
    ["cd repo && sleep 30 && ls", 30],
    ["sleep 2m", 120],
    ["while true; do sleep 15; done", 15],
    ["Start-Sleep -Seconds 45", 45],
    ["Start-Sleep 25", 25],
    ["timeout /t 60", 60],
  ])("reads %s as %i s", (cmd, secs) => {
    expect(longestSleepSeconds(cmd)).toBe(secs);
  });

  it.each([
    "ls -la",
    "npm run sleep-test",
    "echo sleep 100",
    "Start-Sleep -Milliseconds 500",
    "grep sleep file",
  ])("ignores %s", (cmd) => {
    expect(longestSleepSeconds(cmd)).toBe(0);
  });
});

describe("auto-wake", () => {
  it("is on by default and opt-out with =0", () => {
    expect(isBackgroundAutoWakeEnabled({})).toBe(true);
    expect(isBackgroundAutoWakeEnabled({ MUONROI_BACKGROUND_AUTOWAKE: "0" })).toBe(false);
    expect(isBackgroundAutoWakeEnabled({ MUONROI_BACKGROUND_AUTOWAKE: "off" })).toBe(false);
  });

  it("puts every notice into the wake prompt", () => {
    const p = buildBackgroundWakePrompt(["Background agent complete: `a`", "Background process finished: id 2"]);
    expect(p).toContain("Background agent complete: `a`");
    expect(p).toContain("Background process finished: id 2");
  });
});

describe("providerCapacityNote", () => {
  it("is silent below the provider's concurrency", () => {
    expect(providerCapacityNote({ provider: "stepfun", concurrency: 5, agents: 4 })).toBeNull();
    expect(providerCapacityNote({ provider: "x", agents: 40 })).toBeNull();
  });

  it("tells the agent the fan-out has reached the shared limit", () => {
    const note = providerCapacityNote({
      provider: "stepfun",
      concurrency: 5,
      requestsPerMinute: 100,
      tokensPerMinute: 500_000,
      agents: 7,
    });
    expect(note).toContain("7 agents (you + 6 background)");
    expect(note).toContain("5 concurrent requests / 100 requests/min / 500,000 tokens/min");
    expect(note).toMatch(/Do not launch more/);
  });
});

// The prompt rule and the CLI guard read the same number, for every provider.
describe("parallel background-agent limit", () => {
  it("leaves one concurrency slot for the main agent", () => {
    expect(maxParallelBackgroundAgents(5, {})).toBe(4);
    expect(maxParallelBackgroundAgents(1, {})).toBe(1);
  });

  it("still limits a provider that declares no concurrency", () => {
    expect(maxParallelBackgroundAgents(undefined, {})).toBe(UNDECLARED_MAX_PARALLEL_AGENTS);
  });

  it("honours the env override", () => {
    expect(maxParallelBackgroundAgents(5, { MUONROI_MAX_PARALLEL_DELEGATIONS: "2" })).toBe(2);
    expect(maxParallelBackgroundAgents(5, { MUONROI_MAX_PARALLEL_DELEGATIONS: "nope" })).toBe(4);
  });

  it("refuses with the reason and what to do instead", () => {
    const msg = parallelLimitRefusal("anthropic", 4, 4);
    expect(msg).toMatch(/^Refused: 4 background agents/);
    expect(msg).toMatch(/woken/);
  });
});

describe("buildRateLimitRule", () => {
  it("states declared limits and the parallel cap", () => {
    const rule = buildRateLimitRule({
      provider: "stepfun",
      concurrency: 5,
      requestsPerMinute: 100,
      tokensPerMinute: 500_000,
      maxParallelAgents: 4,
    });
    expect(rule).toContain("stepfun account limit: 5 concurrent requests, 100 requests/min, 500,000 tokens/min.");
    expect(rule).toContain("at most 4 background agents at once");
    expect(rule).toMatch(/do NOT respawn at once or launch probe agents/);
  });

  it("never calls an undeclared limit unlimited", () => {
    const rule = buildRateLimitRule({ provider: "deepseek", maxParallelAgents: 3 });
    expect(rule).toContain("deepseek account limit: not published — treat it as limited.");
  });
});
