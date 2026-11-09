import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger, redactSecrets } from "./logger.js";
import { muonroiHome } from "./muonroi-home.js";

export interface IntegrationObservation {
  component: string;
  check: string;
  status: "ready" | "unavailable" | "degraded";
  detail: string;
  cwd?: string;
  ts?: number;
  phase?: string | null;
  durationMs?: number;
}
const directory = () => path.join(muonroiHome(), "usage");

/** Observations are facts about named checks, never an invented global readiness score. */
export function recordIntegrationHealth(entry: IntegrationObservation): void {
  try {
    const ts = entry.ts ?? Date.now();
    fs.mkdirSync(directory(), { recursive: true });
    fs.appendFileSync(
      path.join(directory(), `integration-health-${new Date(ts).toISOString().slice(0, 10)}.jsonl`),
      redactSecrets(JSON.stringify({ ...entry, detail: entry.detail.slice(0, 1200), ts })) + "\n",
    );
  } catch (error) {
    logger.file("warn", "integration", "Could not persist integration observation", {
      error: String(error),
      component: entry.component,
    });
  }
}

export function integrationHealth(hours = 24) {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("Use hours=1..168.");
  const since = Date.now() - hours * 3600000;
  const latest = new Map<string, IntegrationObservation & { failures: number; observations: number }>();
  let observed = 0;
  try {
    const files = fs
      .readdirSync(directory())
      .filter(
        (name) =>
          /^integration-health-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
          name.slice(19, 29) >= new Date(since).toISOString().slice(0, 10),
      )
      .sort();
    for (const file of files) {
      const fd = fs.openSync(path.join(directory(), file), "r");
      let text: string;
      try {
        const size = fs.fstatSync(fd).size,
          start = Math.max(0, size - 1024 * 1024),
          buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
        if (start) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        fs.closeSync(fd);
      }
      for (const line of text.split("\n").filter(Boolean)) {
        let row: IntegrationObservation;
        try {
          row = JSON.parse(line);
        } catch (error) {
          logger.file("warn", "integration", "Invalid integration journal row", { file, error: String(error) });
          continue;
        }
        if (!row.ts || row.ts < since || !row.component || !row.check) continue;
        const key = `${row.component}:${row.check}:${row.cwd ?? ""}`,
          previous = latest.get(key);
        latest.set(key, {
          ...row,
          failures: (previous?.failures ?? 0) + (row.status === "ready" ? 0 : 1),
          observations: (previous?.observations ?? 0) + 1,
        });
        observed++;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      logger.file("warn", "integration", "Could not read integration history", { error: String(error) });
  }
  const checks = [...latest.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return {
    status: !checks.length
      ? "unknown"
      : checks.some((c) => c.status !== "ready")
        ? "degraded"
        : "ready-for-observed-checks",
    hours,
    observations: observed,
    checks: checks.slice(0, 40),
    omitted: Math.max(0, checks.length - 40),
    note: "Bounded recent observed checks, not a whole-system certification. Connected does not mean every tool passed. Optional failures do not block unrelated work; explicit required capabilities are checked before dispatch.",
  };
}

export function observeShellReadiness(input: unknown, output: unknown, cwd: string): void {
  let value = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  if (!value && typeof output === "string" && output.trimStart().startsWith("{")) {
    try {
      value = JSON.parse(output);
    } catch (error) {
      logger.file("debug", "integration", "Non-JSON shell result", { error: String(error) });
    }
  }
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (
    value?.success !== false ||
    !/exit[= :]*127\b|command not found|not recognized as an internal|ENOENT/i.test(text ?? "")
  )
    return;
  const command = redactSecrets(String((input as { command?: unknown })?.command ?? "unknown")).slice(0, 240);
  recordIntegrationHealth({
    component: `toolchain:${createHash("sha256").update(command).digest("hex").slice(0, 16)}`,
    check: "shell-command",
    status: "unavailable",
    cwd,
    detail: `${command}: ${text}`,
  });
}
