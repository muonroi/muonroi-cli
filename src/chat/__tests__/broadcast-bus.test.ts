import { describe, expect, it, vi } from "vitest";
import { publish } from "../broadcast-bus.js";
import type { ChatClient } from "../types.js";
import { DISCORD_CONTENT_BUDGET } from "../verdict-constants.js";

function makeClient(over: Partial<ChatClient> = {}): ChatClient {
  return {
    createChannel: vi.fn(),
    getChannelMessages: vi.fn().mockResolvedValue([]),
    postMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    addChannelPermission: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue("bot"),
    listGuildChannels: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe("publish", () => {
  it("posts content under budget unchanged", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hello" });
    expect(out?.messageId).toBe("m1");
    expect(client.postMessage).toHaveBeenCalledWith("c1", "hello");
  });

  it("returns null on empty content (no API call)", async () => {
    const client = makeClient();
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "" });
    expect(out).toBeNull();
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("splits content over budget at newline boundary", async () => {
    const long = "para1\n\n" + "x".repeat(DISCORD_CONTENT_BUDGET) + "\n\npara3";
    const client = makeClient({
      postMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "m1" })
        .mockResolvedValueOnce({ id: "m2" })
        .mockResolvedValueOnce({ id: "m3" }),
    });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: long });
    const calls = (client.postMessage as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(out?.messageId).toBe("m" + calls.length);
    for (const [, msg] of calls) {
      expect(msg.length).toBeLessThanOrEqual(DISCORD_CONTENT_BUDGET + 30);
    }
  });

  it("returns null on 403 with warning", async () => {
    const err: any = new Error("403");
    err.status = 403;
    const client = makeClient({ postMessage: vi.fn().mockRejectedValue(err) });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hi" });
    expect(out).toBeNull();
  });

  it("returns null on 404 with warning", async () => {
    const err: any = new Error("404");
    err.status = 404;
    const client = makeClient({ postMessage: vi.fn().mockRejectedValue(err) });
    const out = await publish({ client, channelId: "c1", type: "phase-event", content: "hi" });
    expect(out).toBeNull();
  });

  it("preserves unicode/emoji in content", async () => {
    const client = makeClient();
    await publish({ client, channelId: "c1", type: "phase-event", content: "Sprint 🚀 done ✅" });
    expect(client.postMessage).toHaveBeenCalledWith("c1", "Sprint 🚀 done ✅");
  });

  it("split parts include continuation markers", async () => {
    const long = "x".repeat(DISCORD_CONTENT_BUDGET + 500);
    const client = makeClient({
      postMessage: vi.fn().mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce({ id: "m2" }),
    });
    await publish({ client, channelId: "c1", type: "phase-event", content: long });
    const calls = (client.postMessage as any).mock.calls;
    expect(calls[0][1]).toContain("(continued)");
    expect(calls[1][1]).toContain("(continued)");
  });

  it("re-throws non-403/404 errors from postMessage", async () => {
    const err: any = new Error("500 Internal Server Error");
    err.status = 500;
    const client = makeClient({ postMessage: vi.fn().mockRejectedValue(err) });
    await expect(publish({ client, channelId: "c1", type: "phase-event", content: "hi" })).rejects.toThrow("500");
  });
});
