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
import { healthDetailed } from "../ee/health.js";
import type { EEHealthResult } from "../ee/health.js";
import { getDatabase } from "../storage/db.js";
import { listStoredProviders } from "../providers/keychain.js";
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
    const stored = await listStoredProviders();
    if (stored.length > 0) {
      return {
        name: "key_presence",
        status: "pass",
        detail: `API key(s) in OS keychain: ${stored.join(", ")}`,
      };
    }
  } catch {
    /* keytar unavailable — fall through */
  }
  try {
    const settings = loadUserSettings();
    if (settings.apiKey && settings.apiKey.length > 0) {
      return {
        name: "key_presence",
        status: "warn",
        detail: "API key in plaintext user-settings.json — run 'muonroi-cli keys cleanup-settings' to migrate to OS keychain",
      };
    }
  } catch {
    /* settings file unreadable — fall through */
  }
  return {
    name: "key_presence",
    status: "fail",
    detail: "No API key found (run 'muonroi-cli keys set <provider>' or set MUONROI_API_KEY)",
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

async function checkEEDetailed(): Promise<CheckResult> {
  try {
    const result: EEHealthResult = await healthDetailed();

    const serverOk = result.components.server.ok;
    const gatesOk = result.components.gates?.ok ?? true; // null if local mode
    const isHealthy = result.ok;

    const parts = [
      `mode=${result.mode}`,
      `circuit=${result.circuit}`,
      `server=${serverOk ? "ok" : `fail(${result.components.server.status})`}`,
    ];
    if (result.components.gates !== null) {
      parts.push(`gates=${gatesOk ? "ok" : `fail(${result.components.gates.status})`}`);
    }

    if (!isHealthy) {
      const hint = result.mode === "thin-client"
        ? "Hint: check VPS 72.61.127.154:8082 is reachable; verify ~/.experience/config.json serverBaseUrl + serverReadAuthToken"
        : "Hint: start EE locally or configure thin-client in ~/.experience/config.json";
      return {
        name: "ee.health",
        status: "warn",
        detail: `EE unreachable — ${parts.join(", ")}. ${hint}`,
      };
    }

    return {
      name: "ee.health",
      status: "pass",
      detail: parts.join(", "),
    };
  } catch (err) {
    return {
      name: "ee.health",
      status: "warn",
      detail: `EE health probe failed: ${(err as Error).message} — optional, CLI works without EE`,
    };
  }
}

// Threshold: >= 50 consecutive no_match events → brain likely needs bootstrapping
const BRAIN_EMPTY_THRESHOLD = 50;

async function checkBrainEmptiness(): Promise<CheckResult> {
  try {
    const db = getDatabase();

    // Count ee_injection events with event_subtype='no_match' in last 30 days
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM interaction_logs
         WHERE event_type = 'ee_injection'
           AND event_subtype = 'no_match'
           AND created_at >= ?`,
      )
      .get(cutoff) as { cnt: number } | undefined;

    const noMatchCount = row?.cnt ?? 0;

    if (noMatchCount >= BRAIN_EMPTY_THRESHOLD) {
      return {
        name: "ee.brain",
        status: "warn",
        detail: [
          `${noMatchCount} no_match injection events in 30d — brain may need bootstrapping.`,
          `Run 'experience extract' over recent sessions to seed the brain,`,
          `then 'experience evolve' to abstract principles.`,
          `Or lower MUONROI_PIL_SCORE_FLOOR below 0.55 if matches exist but are filtered as noise.`,
        ].join(" "),
      };
    }

    if (noMatchCount > 0) {
      return {
        name: "ee.brain",
        status: "pass",
        detail: `${noMatchCount} no_match events in 30d (within normal range)`,
      };
    }

    return {
      name: "ee.brain",
      status: "pass",
      detail: "No no_match injection events in 30d",
    };
  } catch {
    // fail-open: DB may not be initialized yet
    return { name: "ee.brain", status: "pass", detail: "brain check skipped (DB unavailable)" };
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
    checkEEDetailed(),       // replaces checkEE() — CQ-16c
    checkBrainEmptiness(),   // NEW — CQ-16d
    checkQdrant(),
    checkRecentErrorRate(),
  ]);
}
