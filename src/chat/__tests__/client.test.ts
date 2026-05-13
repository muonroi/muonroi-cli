import { describe, expect, it, vi } from "vitest";
import { DiscordChatProvider } from "../providers/discord/client.js";

describe("DiscordChatProvider", () => {
  function mockFetch(impl: (url: string, init: any) => Promise<Response>) {
    return vi.fn(impl);
  }

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  }

  it("createChannel POSTs to /guilds/<id>/channels with auth header", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/guilds/g1/channels");
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bot tok");
      const body = JSON.parse(init.body);
      expect(body.name).toBe("muonroi-test");
      return jsonResponse({ id: "c1" });
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const out = await client.createChannel("g1", "muonroi-test", { topic: "t", isPrivate: true });
    expect(out.id).toBe("c1");
  });

  it("postMessage sends content as JSON", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/channels/c1/messages");
      const body = JSON.parse(init.body);
      expect(body.content).toBe("hello 🚀");
      return jsonResponse({ id: "m1" });
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const out = await client.postMessage("c1", "hello 🚀");
    expect(out.id).toBe("m1");
  });

  it("getChannelMessages includes after + limit query params", async () => {
    const fetch = mockFetch(async (url) => {
      expect(url).toContain("?after=m0&limit=50");
      return jsonResponse([{ id: "m1", author: { id: "u1", username: "alice" }, content: "hi", timestamp: "t" }]);
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const msgs = await client.getChannelMessages("c1", { afterId: "m0", limit: 50 });
    expect(msgs).toHaveLength(1);
  });

  it("honors Retry-After on 429", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limit", { status: 429, headers: { "Retry-After": "0" } });
      return jsonResponse({ id: "m1" });
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const out = await client.postMessage("c1", "hi");
    expect(out.id).toBe("m1");
    expect(calls).toBe(2);
  });

  it("throws on 401 with status attached", async () => {
    const fetch = mockFetch(async () => new Response("unauthorized", { status: 401 }));
    const client = new DiscordChatProvider("tok", fetch as any);
    await expect(client.postMessage("c1", "hi")).rejects.toMatchObject({ status: 401 });
  });

  it("addChannelPermission uses PUT to /channels/<id>/permissions/<userId>", async () => {
    const fetch = mockFetch(async (url, init) => {
      expect(url).toBe("https://discord.com/api/v10/channels/c1/permissions/u1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body);
      expect(body.type).toBe(1);
      expect(body.allow).toBe("1024");
      return new Response(null, { status: 204 });
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    await client.addChannelPermission("c1", "u1", 1024, 0);
  });

  it("getCurrentUserId caches result after first call", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls += 1;
      return jsonResponse({ id: "me-123" });
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const first = await client.getCurrentUserId();
    const second = await client.getCurrentUserId();
    expect(first).toBe("me-123");
    expect(second).toBe("me-123");
    expect(calls).toBe(1);
  });

  it("listGuildChannels returns array of channel stubs", async () => {
    const fetch = mockFetch(async (url) => {
      expect(url).toContain("/guilds/g1/channels");
      return jsonResponse([{ id: "c1", name: "general" }]);
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const channels = await client.listGuildChannels("g1");
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("c1");
  });

  it("getChannelMessages without params omits query string", async () => {
    const fetch = mockFetch(async (url) => {
      expect(url).not.toContain("?");
      return jsonResponse([]);
    });
    const client = new DiscordChatProvider("tok", fetch as any);
    const msgs = await client.getChannelMessages("c1", {});
    expect(msgs).toHaveLength(0);
  });
});
