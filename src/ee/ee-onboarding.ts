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
import { writeExperienceConfig } from "./auth.js";

/** Best-effort reachability probe — returns true/false, never throws. */
async function probeHealth(baseUrl: string, token?: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: ac.signal,
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

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
        "and recipes so the agent works like a senior on your stack. You can set this up later\n" +
        "by editing ~/.experience/config.json or setting MUONROI_EE_BASE_URL.\n\n",
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

    const reachable = await probeHealth(normalized, token || undefined);
    process.stderr.write(
      reachable
        ? "  ✓ EE server reachable.\n"
        : "  ⚠ Could not reach the EE server right now (saved anyway — run 'muonroi-cli doctor' to recheck).\n",
    );
    return true;
  } catch (err) {
    process.stderr.write(`\nEE setup failed: ${(err as Error)?.message ?? String(err)} — skipped.\n`);
    return false;
  } finally {
    rl.close();
  }
}
