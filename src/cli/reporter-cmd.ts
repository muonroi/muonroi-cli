/**
 * src/cli/reporter-cmd.ts
 *
 * CLI subcommand: muonroi reporter --run <runId> [--product-slug <slug>] [--daily-budget 0.50]
 *
 * Resolves config, wires up real dependencies (DiscordChatProvider + CouncilLLM),
 * then calls runReporter() which handles the main poll loop.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicReadJSON } from "../storage/atomic-io.js";

export interface ReporterCmdOpts {
  run: string;
  productSlug?: string;
  dailyBudget?: string;
  flowDir?: string;
}

interface RunManifest {
  productSlug?: string;
  slug?: string;
}

async function inferProductSlug(flowDir: string, runId: string): Promise<string | null> {
  // Try manifest.json first, then discovery-context.json
  for (const filename of ["manifest.json", "discovery-context.json"]) {
    const filePath = path.join(flowDir, "runs", runId, filename);
    const data = await atomicReadJSON<RunManifest>(filePath);
    if (data?.productSlug) return data.productSlug;
    if (data?.slug) return data.slug;
  }
  return null;
}

function resolveFlowDir(): string {
  return path.join(process.cwd(), ".planning");
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

async function readChannelMapping(productSlug: string): Promise<{ channelId: string; guildId: string } | null> {
  const channelsPath = path.join(muonroiHome(), "discord-channels.json");
  let raw: string;
  try {
    raw = await fs.readFile(channelsPath, "utf8");
  } catch {
    return null;
  }
  const store = JSON.parse(raw) as { items?: Record<string, { channelId: string; guildId: string }> };
  const mapping = store.items?.[productSlug];
  if (!mapping) return null;
  return { channelId: mapping.channelId, guildId: mapping.guildId };
}

export async function runReporterCmd(opts: ReporterCmdOpts): Promise<void> {
  const runId = opts.run;
  const flowDir = opts.flowDir ?? resolveFlowDir();
  const dailyBudget = opts.dailyBudget ? Number.parseFloat(opts.dailyBudget) : 0.5;

  // 1. Resolve product slug
  let productSlug = opts.productSlug;
  if (!productSlug) {
    productSlug = (await inferProductSlug(flowDir, runId)) ?? undefined;
  }
  if (!productSlug) {
    throw new Error(
      `reporter: cannot infer product slug for run ${runId}. ` +
        `Pass --product-slug explicitly or ensure manifest.json exists.`,
    );
  }

  // 2. Load Discord channel mapping
  const channelMapping = await readChannelMapping(productSlug);
  if (!channelMapping) {
    throw new Error(
      `reporter: no Discord channel for product "${productSlug}". ` +
        `Run /ideal first so the channel is created, then re-launch the reporter.`,
    );
  }

  // 3. Resolve Discord token via keychain
  const { loadKeyForProvider } = await import("../providers/keychain.js");
  let discordToken: string;
  try {
    discordToken = await loadKeyForProvider("discord" as any);
  } catch {
    // Fall back to environment variable
    const envToken = process.env.MUONROI_DISCORD_TOKEN;
    if (!envToken) {
      throw new Error(
        "reporter: no Discord token found. " +
          "Set MUONROI_DISCORD_TOKEN or add the token via `muonroi keys set discord <token>`.",
      );
    }
    discordToken = envToken;
  }

  // 4. Resolve leader model + CouncilLLM
  const { resolveLeaderModelDetailed } = await import("../council/leader.js");
  const sessionModelId = process.env.MUONROI_MODEL ?? "deepseek-ai/DeepSeek-V3";
  const leaderResolution = await resolveLeaderModelDetailed(sessionModelId);
  const leaderModelId = leaderResolution.modelId;

  const { createCouncilLLM } = await import("../council/llm.js");
  // Reporter uses a minimal stats object — we don't surface council stats to the user here.
  const stats = { calls: 0, startMs: Date.now(), phases: [] };
  const llm = createCouncilLLM(
    // bash: not used by generate() path; pass a no-op
    { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as any,
    "agent" as any,
    undefined,
    stats,
  );

  // 5. Wire up Discord client
  const { DiscordChatProvider } = await import("../chat/providers/discord/client.js");
  const chat = new DiscordChatProvider(discordToken);

  // 6. Install graceful shutdown
  const ac = new AbortController();
  const shutdown = (): void => {
    console.log("\nReporter stopped.");
    ac.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 7. Banner
  console.log(`Reporter started for run ${runId} (product ${productSlug})`);
  console.log(`Polling Discord channel every ${(5000 / 1000).toFixed(0)}s.`);
  console.log(`Daily LLM budget: $${dailyBudget.toFixed(2)}`);
  console.log("Press Ctrl+C to stop.");

  // 8. Run
  const { runReporter } = await import("../reporter/index.js");
  await runReporter(
    { chat, llm, leaderModelId },
    {
      runId,
      flowDir,
      productSlug,
      channelId: channelMapping.channelId,
      pollIntervalMs: 5_000,
      dailyLlmBudgetUsd: dailyBudget,
      signal: ac.signal,
    },
  );
}
