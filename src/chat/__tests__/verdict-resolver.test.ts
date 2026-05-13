import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClient, ChatMessage } from "../types.js";
import { discordAwaitVerdict } from "../verdict-resolver.js";

function makeClient(over: Partial<ChatClient> = {}): ChatClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "bot-msg" }),
    addChannelPermission: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn(),
    ...over,
  };
}

function msg(id: string, content: string, authorId = "user"): ChatMessage {
  return { id, content, author: { id: authorId, username: "u" }, timestamp: new Date().toISOString() };
}

describe("discordAwaitVerdict", () => {
  let flowDir: string;
  const runId = "r-v";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `vr-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
  });

  function baseArgs(over: Partial<Record<string, unknown>> = {}) {
    return {
      flowDir,
      runId,
      phaseId: "phase-1",
      sprintN: 1,
      productSlug: "abc",
      channelId: "c1",
      client: makeClient(),
      leader: { generate: vi.fn() },
      capUsd: 10,
      remainingUsd: async () => 5,
      reviewSummary: "Sprint 1 complete.",
      backoffDelays: [1, 1, 1],
      pollIntervalMs: 1,
      timeoutMs: 60_000,
      sleep: async () => {},
      now: () => Date.now(),
      fallback: vi.fn().mockResolvedValue({ verdict: "accept" }),
      ...over,
    };
  }

  it("happy accept: single customer message classified accept", async () => {
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "OK accept it")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "accept", reply: "Great!" }),
        costUsd: 0.01,
      }),
    };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("accept");
    expect(out.feedback).toBeUndefined();
  });

  it("reject returns customer message as feedback", async () => {
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "Please fix the auth flow")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "reject", reply: "noted" }),
        costUsd: 0.01,
      }),
    };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("reject");
    expect(out.feedback).toContain("auth flow");
  });

  it("abort returns abort verdict", async () => {
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "Stop the whole thing")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "abort", reply: "OK stopping" }),
        costUsd: 0.01,
      }),
    };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("abort");
  });

  it("timeout returns abort with [timeout-24h]", async () => {
    let nowVal = 0;
    const client = makeClient({ getChannelMessages: vi.fn().mockResolvedValue([]) });
    const out = await discordAwaitVerdict(
      baseArgs({
        client,
        timeoutMs: 100,
        now: () => {
          nowVal += 200;
          return nowVal;
        },
      }),
    );
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("[timeout-24h]");
  });

  it("VERDICT_FLOOR boundary aborts with budget-exhausted", async () => {
    const out = await discordAwaitVerdict(
      baseArgs({
        capUsd: 10,
        remainingUsd: async () => 0.05,
      }),
    );
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("budget-exhausted");
  });

  it("cap_usd=0 immediately aborts", async () => {
    const out = await discordAwaitVerdict(baseArgs({ capUsd: 0, remainingUsd: async () => 0 }));
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("budget-exhausted");
  });

  it("MAX_VERDICT_MESSAGES cap → fallback", async () => {
    const messages = Array.from({ length: 25 }, (_, i) => msg(`m${i}`, "discuss please"));
    const client = makeClient({
      getChannelMessages: vi.fn().mockResolvedValueOnce(messages).mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "discuss", reply: "ok" }),
        costUsd: 0.01,
      }),
    };
    const fallback = vi.fn().mockResolvedValue({ verdict: "accept", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("malformed JSON counts as discuss then continues", async () => {
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "something")])
        .mockResolvedValueOnce([msg("m2", "I accept")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({ content: "not json", costUsd: 0.01 })
        .mockResolvedValueOnce({ content: JSON.stringify({ intent: "accept", reply: "OK" }), costUsd: 0.01 }),
    };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(out.verdict).toBe("accept");
  });

  it("unknown intent ×5 → fallback", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, "msg"));
    const client = makeClient({
      getChannelMessages: vi.fn().mockResolvedValueOnce(messages).mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "maybe", reply: "..." }),
        costUsd: 0.01,
      }),
    };
    const fallback = vi.fn().mockResolvedValue({ verdict: "reject", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("leader transient failure ×3 → fallback", async () => {
    const messages = Array.from({ length: 3 }, (_, i) => msg(`m${i}`, "msg"));
    const client = makeClient({
      getChannelMessages: vi.fn().mockResolvedValueOnce(messages).mockResolvedValue([]),
    });
    const leader = { generate: vi.fn().mockRejectedValue(new Error("net")) };
    const fallback = vi.fn().mockResolvedValue({ verdict: "abort", feedback: "via-fallback" });
    const _out = await discordAwaitVerdict(baseArgs({ client, leader, fallback }));
    expect(fallback).toHaveBeenCalled();
  });

  it("404 on getChannelMessages → fallback", async () => {
    const err = Object.assign(new Error("404"), { status: 404 });
    const client = makeClient({ getChannelMessages: vi.fn().mockRejectedValue(err) });
    const fallback = vi.fn().mockResolvedValue({ verdict: "accept", feedback: "via-fallback" });
    const _out = await discordAwaitVerdict(baseArgs({ client, fallback }));
    expect(fallback).toHaveBeenCalled();
  });

  it("filters out bot's own messages", async () => {
    const client = makeClient({
      getCurrentUserId: vi.fn().mockResolvedValue("bot"),
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "I am bot", "bot"), msg("m2", "I accept", "user")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "accept", reply: "ok" }),
        costUsd: 0.01,
      }),
    };
    const out = await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(leader.generate).toHaveBeenCalledOnce();
    expect(out.verdict).toBe("accept");
  });

  it("persists poll cursor in state.md", async () => {
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m99", "I accept")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "accept", reply: "ok" }),
        costUsd: 0.01,
      }),
    };
    await discordAwaitVerdict(baseArgs({ client, leader }));
    const stateFile = path.join(flowDir, "runs", runId, "state.md");
    const content = await fs.readFile(stateFile, "utf8");
    expect(content).toContain("Discord Poll Cursor");
    expect(content).toContain("m99");
  });

  it("cursor advance is AFTER bot reply post (resume safety)", async () => {
    const order: string[] = [];
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "I accept")])
        .mockResolvedValue([]),
      postMessage: vi.fn().mockImplementation(async () => {
        order.push("postReply");
        return { id: "bot" };
      }),
    });
    const leader = {
      generate: vi.fn().mockImplementation(async () => {
        order.push("leaderCall");
        return { content: JSON.stringify({ intent: "accept", reply: "ok" }), costUsd: 0.01 };
      }),
    };
    await discordAwaitVerdict(baseArgs({ client, leader }));
    expect(order).toEqual(["leaderCall", "postReply"]);
  });

  it("403 on getChannelMessages → fallback", async () => {
    const err = Object.assign(new Error("403"), { status: 403 });
    const client = makeClient({ getChannelMessages: vi.fn().mockRejectedValue(err) });
    const fallback = vi.fn().mockResolvedValue({ verdict: "reject", feedback: "via-fallback" });
    const out = await discordAwaitVerdict(baseArgs({ client, fallback }));
    expect(fallback).toHaveBeenCalled();
    expect(out.verdict).toBe("reject");
  });

  it("cursor update replaces existing entry (not appended)", async () => {
    // Two verdicts on different sprints, cursor for phase-1/sprint-1 gets updated
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m10", "I accept")])
        .mockResolvedValueOnce([msg("m20", "I accept")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "accept", reply: "ok" }),
        costUsd: 0.01,
      }),
    };
    // First run
    await discordAwaitVerdict(baseArgs({ client, leader }));
    // Second run same phase/sprint - cursor entry should be updated (same idx)
    const client2 = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m20", "I accept")])
        .mockResolvedValue([]),
    });
    await discordAwaitVerdict(baseArgs({ client: client2, leader }));
    const stateFile = path.join(flowDir, "runs", runId, "state.md");
    const content = await fs.readFile(stateFile, "utf8");
    // Should have exactly one cursor entry, not two
    const matches = content.match(/"phaseId"/g);
    expect(matches?.length).toBe(1);
  });

  it("budget-exhausted during poll loop aborts with feedback", async () => {
    let remaining = 10;
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([msg("m1", "discuss")])
        .mockResolvedValue([]),
    });
    const leader = {
      generate: vi.fn().mockImplementation(async () => {
        remaining = 0; // exhaust budget after first process
        return { content: JSON.stringify({ intent: "discuss", reply: "ok" }), costUsd: 0.01 };
      }),
    };
    const out = await discordAwaitVerdict(
      baseArgs({ client, leader, capUsd: 10, remainingUsd: async () => remaining }),
    );
    expect(out.verdict).toBe("abort");
    expect(out.feedback).toBe("budget-exhausted");
  });
});
