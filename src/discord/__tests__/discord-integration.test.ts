import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productSlug } from "../../product-loop/product-identity.js";
import { addStakeholder } from "../../product-loop/stakeholder-acl.js";
import { publish } from "../broadcast-bus.js";
import { clearChannelCreatedHooks, ensureChannel } from "../channel-manager.js";
import type { DiscordClient, DiscordMessage } from "../types.js";
import { discordAwaitVerdict } from "../verdict-resolver.js";

function makeClient(over: Partial<DiscordClient> = {}): DiscordClient {
  return {
    createChannel: vi.fn().mockResolvedValue({ id: "newc" }),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "bot-msg" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function customerMsg(id: string, content: string): DiscordMessage {
  return { id, content, author: { id: "u1", username: "alice" }, timestamp: new Date().toISOString() };
}

describe("discord-integration (subsystem F)", () => {
  let tmpHome: string;
  let flowDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `int-${Math.random().toString(36).slice(2)}`);
    flowDir = path.join(tmpHome, "flow");
    await fs.mkdir(flowDir, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
    clearChannelCreatedHooks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
    clearChannelCreatedHooks();
  });

  it("E2E: stakeholder added before channel exists inherits perms on creation", async () => {
    const slug = productSlug("Demo Product");
    await addStakeholder(slug, {
      discordUserId: "111",
      displayName: "alice",
      addedAtUtc: "t",
      addedBy: "cli",
    });
    const client = makeClient();
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    expect(ch).not.toBeNull();
    expect(client.addChannelPermission).toHaveBeenCalledWith("newc", "111", expect.any(Number), 0);
  });

  it("E2E: broadcast posts content under budget verbatim", async () => {
    const slug = productSlug("Demo Product");
    const client = makeClient();
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    expect(ch).not.toBeNull();
    const out = await publish({ client, channelId: ch!.channelId, type: "phase-event", content: "Sprint 1 done" });
    expect(out?.messageId).toBe("bot-msg");
  });

  it("E2E: verdict capture loop returns accept after one customer message", async () => {
    const runId = "r-int";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const slug = productSlug("Demo Product");
    const client = makeClient({
      getChannelMessages: vi
        .fn()
        .mockResolvedValueOnce([customerMsg("m1", "I accept")])
        .mockResolvedValue([]),
    });
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    const leader = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ intent: "accept", reply: "Great!" }),
        costUsd: 0.01,
      }),
    };
    const out = await discordAwaitVerdict({
      flowDir,
      runId,
      phaseId: "phase-1",
      sprintN: 1,
      productSlug: slug,
      channelId: ch!.channelId,
      client,
      leader,
      capUsd: 10,
      remainingUsd: async () => 5,
      reviewSummary: "Sprint 1 complete.",
      pollIntervalMs: 1,
      timeoutMs: 60_000,
      sleep: async () => {},
      now: () => Date.now(),
      backoffDelays: [1],
      fallback: async () => ({ verdict: "abort", feedback: "no" }),
    });
    expect(out.verdict).toBe("accept");
  });

  it("E2E: bot kicked mid-verdict → falls back to terminal path", async () => {
    const runId = "r-int2";
    await fs.mkdir(path.join(flowDir, "runs", runId), { recursive: true });
    const slug = productSlug("Demo Product");
    const err: any = new Error("404");
    err.status = 404;
    const client = makeClient({ getChannelMessages: vi.fn().mockRejectedValue(err) });
    const ch = await ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" });
    const leader = { generate: vi.fn() };
    const fallback = vi.fn().mockResolvedValue({ verdict: "reject", feedback: "via-fallback" });
    const out = await discordAwaitVerdict({
      flowDir,
      runId,
      phaseId: "phase-1",
      sprintN: 1,
      productSlug: slug,
      channelId: ch!.channelId,
      client,
      leader,
      capUsd: 10,
      remainingUsd: async () => 5,
      reviewSummary: "",
      pollIntervalMs: 1,
      timeoutMs: 60_000,
      sleep: async () => {},
      now: () => Date.now(),
      backoffDelays: [1],
      fallback,
    });
    expect(fallback).toHaveBeenCalled();
    expect(out.feedback).toBe("via-fallback");
  });

  it("E2E: empty content broadcast → null, no API call", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "" });
    expect(out).toBeNull();
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("E2E: concurrent ensureChannel for same slug creates once", async () => {
    const slug = productSlug("Demo Product");
    const client = makeClient();
    const [a, b, c] = await Promise.all([
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
      ensureChannel({ client, guildId: "g1", slug, displayName: "Demo Product" }),
    ]);
    expect(a?.channelId).toBe(b?.channelId);
    expect(b?.channelId).toBe(c?.channelId);
    expect(client.createChannel).toHaveBeenCalledOnce();
  });
});
