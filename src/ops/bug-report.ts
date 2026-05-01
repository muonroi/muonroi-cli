/**
 * src/ops/bug-report.ts
 *
 * Anonymized diagnostic bundle builder for muonroi-cli bug-report command.
 * All secrets are scrubbed via the process-wide redactor before inclusion.
 *
 * Config is allowlist-based — only safe fields are included.
 * Error log tail is limited to 20 lines, all run through redactor.
 */

import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import { redactor } from "../utils/redactor.js";
import { type CheckResult, runDoctor } from "./doctor.js";

export interface BugReportBundle {
  generated_at: string;
  bun_version: string;
  os: { platform: string; release: string; arch: string };
  doctor: CheckResult[];
  config_redacted: Record<string, unknown>;
  error_log_tail: string[];
  ee_status: { ok: boolean; status: number } | null;
}

async function loadConfigRedacted(): Promise<Record<string, unknown>> {
  const configPath = path.join(os.homedir(), ".muonroi-cli", "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    // Allowlist — only include safe fields, never include auth tokens or API keys
    return {
      "cap.monthly_usd": config?.cap?.monthly_usd ?? null,
      "router.confidence_threshold": config?.router?.confidence_threshold ?? null,
      mcp_servers_count: Array.isArray(config?.mcpServers) ? config.mcpServers.length : 0,
    };
  } catch {
    return { error: "config not found" };
  }
}

async function loadErrorLogTail(): Promise<string[]> {
  const logPath = path.join(os.homedir(), ".muonroi-cli", "errors.log");
  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-20);
    // Run each line through redactor to scrub any secrets that leaked into logs
    return tail.map((line) => redactor.redact(line));
  } catch {
    return [];
  }
}

export async function buildBugReport(): Promise<BugReportBundle> {
  const [doctor, config, errorTail] = await Promise.all([runDoctor(), loadConfigRedacted(), loadErrorLogTail()]);

  let eeStatus: { ok: boolean; status: number } | null = null;
  try {
    const { health } = await import("../ee/health.js");
    eeStatus = await health();
  } catch {
    /* EE unavailable — leave null */
  }

  return {
    generated_at: new Date().toISOString(),
    bun_version: process.versions.bun ?? "unknown",
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    doctor,
    config_redacted: config,
    error_log_tail: errorTail,
    ee_status: eeStatus,
  };
}

export function formatBugReport(bundle: BugReportBundle): string {
  return JSON.stringify(bundle, null, 2);
}
