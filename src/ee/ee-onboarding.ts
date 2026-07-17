/**
 * First-run Experience Engine setup (interactive, readline — runs BEFORE any TUI
 * code, same pattern as the credential wizard). Offers to connect an EE server
 * and writes ~/.experience/config.json so the agent's record/recall/feedback
 * loop (ee_query / ee_feedback via muonroi-tools) has a brain to talk to.
 *
 * Optional + skippable: a blank URL skips. No hardcoded fallback — a failed
 * health probe is reported, not hidden, and never blocks setup.
 */
import { createInterface } from "node:readline";
import { probeEEHealth, writeExperienceConfig } from "./auth.js";

/**
 * Returns true when a config was written (so the caller can reload EE auth).
 * Returns false when skipped or invalid.
 */
export async function firstRunEESetup(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
  try {
    process.stderr.write(
      "\nExperience Engine (optional) — a shared brain that recalls past decisions, gotchas,\n" +
        "and recipes so the agent works like a senior on your stack. Skipping is fine: you can\n" +
        "connect one at any time with `/ee config <url> [token]`.\n\n",
    );
    const url = (await ask("EE server URL (blank to skip): ")).trim();
    if (!url) {
      process.stderr.write("Skipped Experience Engine setup.\n");
      return false;
    }
    let normalized: string;
    try {
      normalized = new URL(url).toString().replace(/\/$/, "");
    } catch {
      process.stderr.write("That doesn't look like a valid URL — skipped EE setup.\n");
      return false;
    }
    const token = (await ask("EE auth token (blank if the server needs none): ")).trim();
    await writeExperienceConfig({
      serverBaseUrl: normalized,
      ...(token ? { serverAuthToken: token } : {}),
    });
    process.stderr.write(`Wrote Experience Engine config → ~/.experience/config.json (serverBaseUrl=${normalized}).\n`);

    const health = await probeEEHealth(normalized, token || undefined);
    process.stderr.write(
      health.ok
        ? "  ✓ EE server reachable.\n"
        : `  ⚠ Could not reach the EE server right now — ${health.detail} (saved anyway; recheck with '/ee config').\n`,
    );
    return true;
  } catch (err) {
    process.stderr.write(`\nEE setup failed: ${(err as Error)?.message ?? String(err)} — skipped.\n`);
    return false;
  } finally {
    rl.close();
  }
}
