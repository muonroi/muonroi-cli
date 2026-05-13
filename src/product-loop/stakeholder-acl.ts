import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText } from "../storage/atomic-io.js";
import { withFileLock } from "../utils/file-lock.js";

const SCHEMA_VERSION = 1;

export interface Stakeholder {
  discordUserId: string;
  displayName: string;
  addedAtUtc: string;
  addedBy: "owner" | "cli";
}

export interface StakeholderStore {
  version: number;
  items: Record<string, { productSlug: string; stakeholders: Stakeholder[] }>;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function storePath(): string {
  return path.join(muonroiHome(), "stakeholders.json");
}

async function readStore(): Promise<StakeholderStore> {
  const filePath = storePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { version: SCHEMA_VERSION, items: {} };
  }
  let parsed: StakeholderStore;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.rename(filePath, `${filePath}.corrupt-${ts}`).catch(() => {});
    return { version: SCHEMA_VERSION, items: {} };
  }
  if (parsed.version !== SCHEMA_VERSION) {
    throw new Error(`stakeholder-acl: unsupported schema version ${parsed.version} (expected ${SCHEMA_VERSION})`);
  }
  return parsed;
}

async function writeStore(store: StakeholderStore): Promise<void> {
  await fs.mkdir(muonroiHome(), { recursive: true });
  await atomicWriteText(storePath(), JSON.stringify(store, null, 2));
}

export async function listStakeholders(slug: string): Promise<Stakeholder[]> {
  const store = await readStore();
  return store.items[slug]?.stakeholders ?? [];
}

export async function addStakeholder(slug: string, s: Stakeholder): Promise<void> {
  await withFileLock(storePath(), async () => {
    const store = await readStore();
    const entry = store.items[slug] ?? { productSlug: slug, stakeholders: [] };
    if (!entry.stakeholders.some((x) => x.discordUserId === s.discordUserId)) {
      entry.stakeholders.push(s);
    }
    store.items[slug] = entry;
    await writeStore(store);
  });
}

export async function removeStakeholder(slug: string, discordUserId: string): Promise<void> {
  await withFileLock(storePath(), async () => {
    const store = await readStore();
    const entry = store.items[slug];
    if (!entry) return;
    entry.stakeholders = entry.stakeholders.filter((x) => x.discordUserId !== discordUserId);
    store.items[slug] = entry;
    await writeStore(store);
  });
}
