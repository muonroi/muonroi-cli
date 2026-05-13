export interface DiscordMessage {
  id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}

export interface DiscordClient {
  createChannel(guildId: string, name: string, opts: { topic?: string; isPrivate?: boolean }): Promise<{ id: string }>;
  getChannelMessages(channelId: string, opts: { afterId?: string; limit?: number }): Promise<DiscordMessage[]>;
  postMessage(channelId: string, content: string): Promise<{ id: string }>;
  addChannelPermission(channelId: string, userId: string, allow: number, deny: number): Promise<void>;
  getCurrentUserId(): Promise<string>;
  listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string }>>;
}

export interface DiscordChannelMapping {
  productSlug: string;
  channelId: string;
  guildId: string;
  createdAtUtc: string;
  displayName: string;
}

export interface PollCursor {
  phaseId: string;
  sprintN: number;
  lastSeenId: string;
  lastPolledAtUtc: string;
}

export type BroadcastType = "phase-event" | "env-provisioning" | "env-ready" | "env-teardown" | "custom";

/** Discord API permission bits we use. */
export const PERMISSION_BITS = {
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  READ_MESSAGE_HISTORY: 1 << 16,
} as const;

export const STAKEHOLDER_ALLOW =
  PERMISSION_BITS.VIEW_CHANNEL | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.READ_MESSAGE_HISTORY;
