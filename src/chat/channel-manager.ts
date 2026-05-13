import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listStakeholders } from "../product-loop/stakeholder-acl.js";
import { atomicWriteText } from "../storage/atomic-io.js";
import { withFileLock } from "../utils/file-lock.js";
import { type ChatChannelMapping, type ChatClient, STAKEHOLDER_ALLOW } from "./types.js";

const SCHEMA_VERSION = 1;

interface ChannelStore {
  version: number;
  items: Record<string, ChatChannelMapping>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function storePath(): string {
  return path.join(muonroiHome(), "discord-channels.json");
}

async function readStore(): Promise<ChannelStore> {
  const fp = storePath();
  let raw: string;
  try {
    raw = await fs.readFile(fp, "utf8");
  } catch {
    return { version: SCHEMA_VERSION, items: {} };
  }
  let parsed: ChannelStore;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(fp, `${fp}.corrupt-${ts}`).catch(() => {});
    return { version: SCHEMA_VERSION, items: {} };
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`channel-manager: unsupported schema version ${parsed.version}`);
  }
  return parsed;
}

async function writeStore(store: ChannelStore): Promise<void> {
  await fs.mkdir(muonroiHome(), { recursive: true });
  await atomicWriteText(storePath(), JSON.stringify(store, null, 2));
}

type ChannelCreatedHook = (slug: string, channelId: string) => Promise<void>;
let hooks: ChannelCreatedHook[] = [];

export function registerChannelCreatedHook(fn: ChannelCreatedHook): void {
  hooks.push(fn);
}

export function clearChannelCreatedHooks(): void {
  hooks = [];
}

const inFlight = new Map<string, Promise<{ channelId: string; created: boolean } | null>>();

export interface EnsureChannelArgs {
  client: ChatClient;
  guildId: string;
  slug: string;
  displayName: string;
  eager?: boolean;
}

export async function ensureChannel(args: EnsureChannelArgs): Promise<{ channelId: string; created: boolean } | null> {
  const key = `${args.guildId}:${args.slug}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = ensureChannelInner(args).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function ensureChannelInner(args: EnsureChannelArgs): Promise<{ channelId: string; created: boolean } | null> {
  try {
    return await withFileLock(storePath(), async () => {
      const store = await readStore();

      const cached = store.items[args.slug];
      if (cached) {
        const live = await args.client.listGuildChannels(args.guildId);
        if (live.some((c) => c.id === cached.channelId)) {
          return { channelId: cached.channelId, created: false };
        }
        // Cached channel no longer exists — fall through to create
        delete store.items[args.slug];
      } else {
        const live = await args.client.listGuildChannels(args.guildId);
        const named = live.find((c) => c.name === `muonroi-${args.slug}`);
        if (named) {
          const mapping: ChatChannelMapping = {
            productSlug: args.slug,
            channelId: named.id,
            guildId: args.guildId,
            createdAtUtc: new Date().toISOString(),
            displayName: args.displayName,
          };
          store.items[args.slug] = mapping;
          await writeStore(store);
          return { channelId: named.id, created: false };
        }
      }

      const created = await args.client.createChannel(args.guildId, `muonroi-${args.slug}`, {
        topic: `${args.displayName} — managed by muonroi-cli`,
        isPrivate: true,
      });

      const stakeholders = await listStakeholders(args.slug);
      for (const s of stakeholders) {
        await args.client.addChannelPermission(created.id, s.discordUserId, STAKEHOLDER_ALLOW, 0).catch(() => {});
      }

      const mapping: ChatChannelMapping = {
        productSlug: args.slug,
        channelId: created.id,
        guildId: args.guildId,
        createdAtUtc: new Date().toISOString(),
        displayName: args.displayName,
      };
      store.items[args.slug] = mapping;
      await writeStore(store);

      for (const hook of hooks) {
        await hook(args.slug, created.id).catch(() => {});
      }

      return { channelId: created.id, created: true };
    });
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      console.warn(`Chat channel-manager: ${e.status} (token/permission); F disabled for this run`);
      return null;
    }
    throw e;
  }
}
