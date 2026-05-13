import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntentDetectionTrace } from "./types.js";

export type IntentTraceSnapshot = IntentDetectionTrace;

export interface PilLayerSnapshot {
  name: string;
  charsBefore: number;
  charsAfter: number;
  charsDelta: number;
  durationMs: number;
}

export interface PilBudgetLogEntry {
  ts: number;
  sessionId: string | null;
  taskType: string | null;
  domain: string | null;
  confidence: number;
  rawChars: number;
  enrichedChars: number;
  totalDeltaChars: number;
  totalMs: number;
  layers: PilLayerSnapshot[];
  fallbackReason: string | null;
  intentDetection: IntentTraceSnapshot | null;
}

function muonroiHome(): string {
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function logDir(): string {
  return path.join(muonroiHome(), "pil");
}

function logPath(date: string): string {
  return path.join(logDir(), `budget-log-${date}.jsonl`);
}

export async function appendPilLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(logDir(), { recursive: true });
    await fs.appendFile(logPath(todayUtc()), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // best-effort, never throw
  }
}

export async function listPilLogDates(): Promise<string[]> {
  try {
    const files = await fs.readdir(logDir());
    return files
      .filter((f) => f.startsWith("budget-log-") && f.endsWith(".jsonl"))
      .map((f) => f.slice("budget-log-".length, -".jsonl".length))
      .sort();
  } catch {
    return [];
  }
}

export async function readPilLog(date: string): Promise<PilBudgetLogEntry[]> {
  try {
    const text = await fs.readFile(logPath(date), "utf8");
    const out: PilBudgetLogEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as PilBudgetLogEntry);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}
