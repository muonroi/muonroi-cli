import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { publish } from "../discord/broadcast-bus.js";
import type { DiscordChannelMapping, DiscordClient } from "../discord/types.js";
import { STAKEHOLDER_ALLOW } from "../discord/types.js";
import { productSlug } from "../product-loop/product-identity.js";
import { addStakeholder, listStakeholders } from "../product-loop/stakeholder-acl.js";

export type ShareResult =
  | { kind: "granted"; userId: string; slug: string; channelId: string }
  | { kind: "acl-only"; userId: string; slug: string }
  | { kind: "already-stakeholder"; userId: string; slug: string }
  | { kind: "perm-error"; userId: string; slug: string; status?: number }
  | { kind: "error"; message: string };

export interface RunShareArgs {
  cwd: string;
  user: string;
  product?: string;
  display?: string;
  client: DiscordClient;
}

function parseUserId(input: string): string | null {
  const mention = input.match(/^<@!?(\d{15,21})>$/);
  if (mention) return mention[1];
  if (/^\d{15,21}$/.test(input)) return input;
  return null;
}

async function resolveSlug(cwd: string, productArg: string | undefined): Promise<string | null> {
  if (productArg) return productArg;
  const runsDir = path.join(cwd, ".flow", "runs");
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return null;
  }
  let latest: { slug: string; mtime: number } | null = null;
  for (const entry of entries) {
    const manifestPath = path.join(runsDir, entry, "manifest.json");
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(manifestPath);
    } catch {
      continue;
    }
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const m = JSON.parse(raw) as { idea: string };
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { slug: productSlug(m.idea), mtime: stat.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }
  return latest?.slug ?? null;
}

interface ChannelStore {
  version: number;
  items: Record<string, DiscordChannelMapping>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

async function readChannelMapping(slug: string): Promise<DiscordChannelMapping | null> {
  const fp = path.join(muonroiHome(), "discord-channels.json");
  let raw: string;
  try {
    raw = await fs.readFile(fp, "utf8");
  } catch {
    return null;
  }
  try {
    const store = JSON.parse(raw) as ChannelStore;
    return store.items[slug] ?? null;
  } catch {
    return null;
  }
}

export async function runShareCommand(args: RunShareArgs): Promise<ShareResult> {
  const userId = parseUserId(args.user);
  if (!userId) {
    return { kind: "error", message: `Invalid user identifier: ${args.user}. Use raw snowflake ID or <@…> mention.` };
  }
  const slug = await resolveSlug(args.cwd, args.product);
  if (!slug) {
    return { kind: "error", message: "No active product found; pass --product <slug>." };
  }
  const displayName = args.display ?? userId;

  const existing = await listStakeholders(slug);
  const alreadyMember = existing.some((s) => s.discordUserId === userId);
  if (alreadyMember) {
    return { kind: "already-stakeholder", userId, slug };
  }

  await addStakeholder(slug, {
    discordUserId: userId,
    displayName,
    addedAtUtc: new Date().toISOString(),
    addedBy: "cli",
  });

  const mapping = await readChannelMapping(slug);
  if (!mapping) {
    return { kind: "acl-only", userId, slug };
  }

  try {
    await args.client.addChannelPermission(mapping.channelId, userId, STAKEHOLDER_ALLOW, 0);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    return { kind: "perm-error", userId, slug, status };
  }

  await publish({
    client: args.client,
    channelId: mapping.channelId,
    type: "phase-event",
    content: `<@${userId}> đã được thêm vào product ${mapping.displayName}.`,
  }).catch(() => {});

  return { kind: "granted", userId, slug, channelId: mapping.channelId };
}
