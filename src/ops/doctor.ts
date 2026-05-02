/**
 * src/ops/doctor.ts
 *
 * Health check runner for muonroi-cli doctor command.
 * Runs 7 named checks and returns pass/warn/fail results.
 *
 * Checks: bun_version, os, key_presence, ollama, ee, qdrant, error_rate
 * Never throws — all checks handle errors gracefully (warn, not crash).
 */

import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import { health as eeHealth } from "../ee/health.js";
import { loadUserSettings } from "../utils/settings.js";

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function icon(status: "pass" | "warn" | "fail"): string {
  return status === "pass" ? "[PASS]" : status === "warn" ? "[WARN]" : "[FAIL]";
}

export function formatDoctorReport(results: CheckResult[], version?: string): string {
  const lines: string[] = [];
  lines.push(`  muonroi-cli v${version || "unknown"}`);
  lines.push("");
  for (const r of results) {
    lines.push(`  ${icon(r.status)} ${r.name}: ${r.detail}`);
  }
  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  lines.push("");
  lines.push(`  Summary: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
  lines.push("");
  lines.push("  For managed Experience Engine: https://muonroi.com/cloud");
  return lines.join("\n");
}

async function checkBunVersion(): Promise<CheckResult> {
  const bunVersion = process.versions.bun;
  if (!bunVersion) {
    return { name: "bun_version", status: "fail", detail: "Not running under Bun" };
  }
  // Compare semver: need >= 1.3.13
  const [major, minor, patch] = bunVersion.split(".").map(Number);
  const ok = major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 13)));
  return {
    name: "bun_version",
    status: ok ? "pass" : "fail",
    detail: `Bun ${bunVersion}${ok ? "" : " (need >= 1.3.13)"}`,
  };
}

async function checkOS(): Promise<CheckResult> {
  return {
    name: "os",
    status: "pass",
    detail: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
}

async function checkKeyPresence(): Promise<CheckResult> {
  const envKey = process.env.MUONROI_API_KEY;
  if (envKey && envKey.length > 0) {
    return {
      name: "key_presence",
      status: "pass",
      detail: "MUONROI_API_KEY set via env var",
    };
  }
  try {
    const settings = loadUserSettings();
    if (settings.apiKey && settings.apiKey.length > 0) {
      return { name: "key_presence", status: "pass", detail: "API key found in user-settings.json" };
    }
  } catch {
    /* settings file unreadable — fall through */
  }
  return {
    name: "key_presence",
    status: "fail",
    detail: "No API key found (set MUONROI_API_KEY or run muonroi-cli to configure)",
  };
}

async function checkOllamaHealth(): Promise<CheckResult> {
  try {
    const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
    const resp = await fetch(`${ollamaUrl.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return {
      name: "ollama",
      status: resp.ok ? "pass" : "warn",
      detail: resp.ok ? `Ollama reachable (${ollamaUrl})` : `Ollama responded ${resp.status}`,
    };
  } catch {
    return { name: "ollama", status: "warn", detail: "Ollama not running (optional — needed for warm-path routing)" };
  }
}

async function checkEE(): Promise<CheckResult> {
  try {
    const result = await eeHealth();
    if (result.ok) return { name: "ee", status: "pass", detail: "Experience Engine healthy" };
    return {
      name: "ee",
      status: "warn",
      detail: result.status === 0
        ? "Experience Engine not running (optional — CLI works without it)"
        : `EE responded ${result.status} (optional)`,
    };
  } catch {
    return { name: "ee", status: "warn", detail: "Experience Engine not running (optional — CLI works without it)" };
  }
}

async function checkQdrant(): Promise<CheckResult> {
  try {
    const qdrantUrl = process.env.QDRANT_URL ?? "http://localhost:6333";
    const resp = await fetch(`${qdrantUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return {
      name: "qdrant",
      status: resp.ok ? "pass" : "warn",
      detail: resp.ok ? `Qdrant healthy (${qdrantUrl})` : `Qdrant responded ${resp.status}`,
    };
  } catch {
    return { name: "qdrant", status: "warn", detail: "Qdrant not running locally (OK if EE is remote)" };
  }
}

async function checkRecentErrorRate(): Promise<CheckResult> {
  const errorLogPath = path.join(os.homedir(), ".muonroi-cli", "errors.log");
  try {
    const content = await readFile(errorLogPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const oneDayAgo = Date.now() - 86400000;
    // Count lines with ISO timestamps in last 24h (best-effort)
    const recentCount = lines.filter((l) => {
      const match = l.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
      return match && new Date(match[1]).getTime() > oneDayAgo;
    }).length;
    if (recentCount > 50) {
      return { name: "error_rate", status: "fail", detail: `${recentCount} errors in last 24h` };
    }
    if (recentCount > 10) {
      return { name: "error_rate", status: "warn", detail: `${recentCount} errors in last 24h` };
    }
    return { name: "error_rate", status: "pass", detail: `${recentCount} errors in last 24h` };
  } catch {
    return { name: "error_rate", status: "pass", detail: "No error log found (clean)" };
  }
}

export async function runDoctor(): Promise<CheckResult[]> {
  return Promise.all([
    checkBunVersion(),
    checkOS(),
    checkKeyPresence(),
    checkOllamaHealth(),
    checkEE(),
    checkQdrant(),
    checkRecentErrorRate(),
  ]);
}
