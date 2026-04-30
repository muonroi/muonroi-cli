/**
 * src/ops/doctor.ts
 *
 * Health check runner for muonroi-cli doctor command.
 * Runs 7 named checks and returns pass/warn/fail results.
 *
 * Checks: bun_version, os, key_presence, ollama, ee, qdrant, error_rate
 * Never throws — all checks handle errors gracefully (warn, not crash).
 */

import os from "os";
import { readFile } from "fs/promises";
import path from "path";
import { health as eeHealth } from "../ee/health.js";

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function icon(status: "pass" | "warn" | "fail"): string {
  return status === "pass" ? "[PASS]" : status === "warn" ? "[WARN]" : "[FAIL]";
}

export function formatDoctorReport(results: CheckResult[]): string {
  const lines = results.map((r) => `  ${icon(r.status)} ${r.name}: ${r.detail}`);
  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  lines.push("");
  lines.push(`  Summary: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
  return lines.join("\n");
}

async function checkBunVersion(): Promise<CheckResult> {
  const bunVersion = process.versions.bun;
  if (!bunVersion) {
    return { name: "bun_version", status: "fail", detail: "Not running under Bun" };
  }
  // Compare semver: need >= 1.3.13
  const [major, minor, patch] = bunVersion.split(".").map(Number);
  const ok =
    major > 1 ||
    (major === 1 && (minor > 3 || (minor === 3 && patch >= 13)));
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
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 0) {
    return {
      name: "key_presence",
      status: "pass",
      detail: "ANTHROPIC_API_KEY set via env var",
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keytar = await import("keytar") as any;
    const mod = keytar.default ?? keytar;
    const stored = await mod.getPassword("muonroi-cli", "anthropic-api-key");
    if (stored) {
      return { name: "key_presence", status: "pass", detail: "API key found in OS keychain" };
    }
  } catch {
    /* keytar not available — fall through */
  }
  return {
    name: "key_presence",
    status: "fail",
    detail: "No API key found (set ANTHROPIC_API_KEY or store in keychain)",
  };
}

async function checkOllamaHealth(): Promise<CheckResult> {
  try {
    const resp = await fetch("http://100.79.164.25:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    return {
      name: "ollama",
      status: resp.ok ? "pass" : "warn",
      detail: resp.ok ? "Ollama VPS reachable" : `Ollama responded ${resp.status}`,
    };
  } catch {
    return { name: "ollama", status: "warn", detail: "Ollama VPS unreachable (optional)" };
  }
}

async function checkEE(): Promise<CheckResult> {
  try {
    const result = await eeHealth();
    return {
      name: "ee",
      status: result.ok ? "pass" : "warn",
      detail: result.ok
        ? "Experience Engine healthy"
        : `EE status ${result.status}`,
    };
  } catch {
    return { name: "ee", status: "warn", detail: "Experience Engine unreachable (optional)" };
  }
}

async function checkQdrant(): Promise<CheckResult> {
  try {
    const resp = await fetch("http://localhost:6333/healthz", {
      signal: AbortSignal.timeout(1000),
    });
    return {
      name: "qdrant",
      status: resp.ok ? "pass" : "warn",
      detail: resp.ok ? "Qdrant healthy" : `Qdrant responded ${resp.status}`,
    };
  } catch {
    return { name: "qdrant", status: "warn", detail: "Qdrant unreachable (optional for v1)" };
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
