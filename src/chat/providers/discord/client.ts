import { withRateLimitBackoff } from "../../../utils/rate-limit.js";
import type { ChatClient, ChatMessage } from "../../types.js";

const API_BASE = "https://discord.com/api/v10";

interface DiscordError extends Error {
  status?: number;
  retryAfter?: number;
}

function makeError(res: Response, body: string): DiscordError {
  const err: DiscordError = new Error(`Discord ${res.status}: ${body.slice(0, 200)}`);
  err.status = res.status;
  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    if (ra) err.retryAfter = Number(ra) * 1000;
  }
  return err;
}

export class DiscordChatProvider implements ChatClient {
  private readonly headers: Record<string, string>;
  private cachedUserId?: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.headers = {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "muonroi-cli (https://github.com/muonroi/muonroi-cli, 0.0.0)",
    };
  }

  private async call<T>(method: string, path: string, body?: unknown, parseJson: boolean = true): Promise<T> {
    return withRateLimitBackoff<T>(async () => {
      const init: RequestInit = { method, headers: this.headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(`${API_BASE}${path}`, init as any);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!res.ok) throw makeError(res, text);
      if (!parseJson) return undefined as T;
      return JSON.parse(text) as T;
    });
  }

  async createChannel(
    guildId: string,
    name: string,
    opts: { topic?: string; isPrivate?: boolean },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = { name, type: 0 };
    if (opts.topic !== undefined) body.topic = opts.topic;
    if (opts.isPrivate) body.permission_overwrites = [{ id: guildId, type: 0, allow: "0", deny: "1024" }];
    return this.call("POST", `/guilds/${guildId}/channels`, body);
  }

  async getChannelMessages(channelId: string, opts: { afterId?: string; limit?: number }): Promise<ChatMessage[]> {
    const params = new URLSearchParams();
    if (opts.afterId) params.set("after", opts.afterId);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.call("GET", `/channels/${channelId}/messages${qs ? "?" + qs : ""}`);
  }

  async postMessage(channelId: string, content: string): Promise<{ id: string }> {
    return this.call("POST", `/channels/${channelId}/messages`, { content });
  }

  async addChannelPermission(channelId: string, userId: string, allow: number, deny: number): Promise<void> {
    await this.call(
      "PUT",
      `/channels/${channelId}/permissions/${userId}`,
      { type: 1, allow: String(allow), deny: String(deny) },
      false,
    );
  }

  async getCurrentUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const me = await this.call<{ id: string }>("GET", "/users/@me");
    this.cachedUserId = me.id;
    return me.id;
  }

  async listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>> {
    return this.call("GET", `/guilds/${guildId}/channels`);
  }
}
