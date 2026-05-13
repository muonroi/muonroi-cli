import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearChannelCreatedHooks, ensureChannel, registerChannelCreatedHook } from "../channel-manager.js";
import type { ChatClient } from "../types.js";

function makeClient(over: Partial<ChatClient> = {}): ChatClient {
  return {
    createChannel: vi.fn().mockResolvedValue({ id: "newc" }),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "m" }),
    addChannelPermission: vi.fn().mockResolvedValue(undefined),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("ensureChannel", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `cmgr-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpHome, { recursive: true });
    prevHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
    clearChannelCreatedHooks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = prevHome;
    clearChannelCreatedHooks();
  });

  it("creates channel on first call (cache miss + name miss)", async () => {
    const client = makeClient();
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toEqual({ channelId: "newc", created: true });
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("cache hit on second call", async () => {
    const client = makeClient({
      listGuildChannels: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: "newc", name: "muonroi-abc" }]),
    });
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    const second = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(second).toEqual({ channelId: "newc", created: false });
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("finds existing channel by name when cache missing", async () => {
    const client = makeClient({
      listGuildChannels: vi.fn().mockResolvedValue([{ id: "existing", name: "muonroi-abc" }]),
    });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toEqual({ channelId: "existing", created: false });
    expect(client.createChannel).not.toHaveBeenCalled();
  });

  it("in-process dedup: concurrent calls share one create", async () => {
    const client = makeClient();
    const [a, b] = await Promise.all([
      ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" }),
      ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" }),
    ]);
    expect(a?.channelId).toBe(b?.channelId);
    expect(client.createChannel).toHaveBeenCalledOnce();
  });

  it("returns null on 401 token error", async () => {
    const err: any = new Error("401");
    err.status = 401;
    const client = makeClient({ listGuildChannels: vi.fn().mockRejectedValue(err) });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toBeNull();
  });

  it("returns null on 403 perm error", async () => {
    const err: any = new Error("403");
    err.status = 403;
    const client = makeClient({ createChannel: vi.fn().mockRejectedValue(err) });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out).toBeNull();
  });

  it("syncs permissions from stakeholder-acl after create", async () => {
    const { addStakeholder } = await import("../../product-loop/stakeholder-acl.js");
    await addStakeholder("abc", {
      discordUserId: "u1",
      displayName: "alice",
      addedAtUtc: "t",
      addedBy: "cli",
    });
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(client.addChannelPermission).toHaveBeenCalledWith("newc", "u1", expect.any(Number), 0);
  });

  it("fires onChannelCreated hooks after create", async () => {
    const client = makeClient();
    const hook = vi.fn().mockResolvedValue(undefined);
    registerChannelCreatedHook(hook);
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(hook).toHaveBeenCalledWith("abc", "newc");
  });

  it("clearChannelCreatedHooks isolates tests", async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerChannelCreatedHook(hook);
    clearChannelCreatedHooks();
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("persists mapping to discord-channels.json", async () => {
    const client = makeClient();
    await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    const raw = await fs.readFile(path.join(tmpHome, "discord-channels.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.items.abc.channelId).toBe("newc");
  });

  it("retries create on cached-channel 404 verification", async () => {
    const cachePath = path.join(tmpHome, "discord-channels.json");
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        items: {
          abc: { productSlug: "abc", channelId: "stale", guildId: "g1", createdAtUtc: "t", displayName: "x" },
        },
      }),
    );
    const client = makeClient({
      listGuildChannels: vi.fn().mockResolvedValue([]),
    });
    const out = await ensureChannel({ client, guildId: "g1", slug: "abc", displayName: "Demo" });
    expect(out?.channelId).toBe("newc");
    expect(client.createChannel).toHaveBeenCalledOnce();
  });
});
