/**
 * scripts/e2e-council-debug.ts
 *
 * Real e2e harness that drives `runDebate` end-to-end against the configured
 * provider/models and writes a detailed JSONL log of every LLM call so we can
 * diagnose *why* turns return empty (vs. retry-helper guesses).
 *
 * Usage (PowerShell):
 *   $env:MUONROI_COUNCIL_DEBUG_LOG = "D:\sources\Core\muonroi-cli\council-debug.jsonl"
 *   npx tsx scripts/e2e-council-debug.ts
 *
 * The script:
 *   1. Spins up createCouncilLLM (real one — hits provider).
 *   2. Calls llm.generate/llm.debate against the two configured models with
 *      probes of increasing prompt size, confirming behavior at each step.
 *   3. Runs a single 2-participant × 1-round debate.
 *   4. Prints a summary of the JSONL log (counts of empty/ok/error, finish
 *      reasons, reasoningText sizes).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createCouncilLLM } from "../src/council/llm.js";
import type { CouncilStats } from "../src/council/types.js";

const LOG_PATH = process.env.MUONROI_COUNCIL_DEBUG_LOG ?? path.resolve("council-debug.jsonl");

if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
process.env.MUONROI_COUNCIL_DEBUG_LOG = LOG_PATH;
console.log(`Debug log → ${LOG_PATH}`);

const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";

const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };

// Minimal BashTool shim — council debate may call tools but for these probes
// we drive plain generate/debate paths so the tools never actually fire.
const noopBash = {
  description: "noop",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } as never,
  execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
} as unknown as Parameters<typeof createCouncilLLM>[0];

const llm = createCouncilLLM(noopBash, "default", "e2e-debug-session", stats);

interface ProbeResult {
  label: string;
  model: string;
  textLen: number;
  textHead: string;
  durationMs: number;
  ok: boolean;
  errMsg?: string;
}

async function probeGenerate(label: string, model: string, system: string, prompt: string, maxTokens: number): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const text = await llm.generate(model, system, prompt, maxTokens);
    return { label, model, textLen: text.length, textHead: text.slice(0, 120), durationMs: Date.now() - t0, ok: true };
  } catch (err) {
    return { label, model, textLen: 0, textHead: "", durationMs: Date.now() - t0, ok: false, errMsg: err instanceof Error ? err.message : String(err) };
  }
}

async function probeDebate(label: string, model: string, system: string, prompt: string): Promise<ProbeResult & { toolCount: number }> {
  const t0 = Date.now();
  try {
    const res = await llm.debate(model, system, prompt);
    return { label, model, textLen: res.text.length, textHead: res.text.slice(0, 120), durationMs: Date.now() - t0, ok: true, toolCount: res.toolCalls.length };
  } catch (err) {
    return { label, model, textLen: 0, textHead: "", durationMs: Date.now() - t0, ok: false, errMsg: err instanceof Error ? err.message : String(err), toolCount: 0 };
  }
}

async function main(): Promise<void> {
  console.log("\n== PROBE 1: tiny generate, both models, max_tokens=64 ==\n");
  const r1a = await probeGenerate("tiny-flash-64", FLASH, "You are a concise assistant.", "Reply with exactly the word: ok", 64);
  console.log(r1a);
  const r1b = await probeGenerate("tiny-pro-64", PRO, "You are a concise assistant.", "Reply with exactly the word: ok", 64);
  console.log(r1b);

  console.log("\n== PROBE 2: tiny generate, both models, max_tokens=2048 (council default) ==\n");
  const r2a = await probeGenerate("tiny-flash-2048", FLASH, "You are a concise assistant.", "Reply with exactly the word: ok", 2048);
  console.log(r2a);
  const r2b = await probeGenerate("tiny-pro-2048", PRO, "You are a concise assistant.", "Reply with exactly the word: ok", 2048);
  console.log(r2b);

  console.log("\n== PROBE 3: realistic debate-style prompt (~3KB), max_tokens=2048 ==\n");
  const realisticSystem = `You are an expert in browser-extension architecture. Take a strong stance and defend it with concrete evidence and citations. Output English only.`;
  const realisticPrompt = `## Topic\nDesign a Chrome MV3 extension that translates highlighted text in PDFs.\n\n## Partner Position\nUse PDF.js viewer replacement via declarativeNetRequest. Capture selection in main world via window.PDFViewerApplication.pdfViewer.getSelectedText(). Translate via Google Cloud Translation API with chrome.storage cache.\n\n## Your Task\nReply substantively (≥300 words). Identify at least one architectural risk in the partner's plan, propose a concrete mitigation, and cite the Chrome docs URL backing your claim. Do NOT call tools; respond from your existing knowledge.`;

  const r3a = await probeDebate("debate-flash", FLASH, realisticSystem, realisticPrompt);
  console.log(r3a);
  const r3b = await probeDebate("debate-pro", PRO, realisticSystem, realisticPrompt);
  console.log(r3b);

  console.log("\n== Log summary ==\n");
  const lines = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n") : [];
  const byKey: Record<string, number> = {};
  const finishReasons: Record<string, number> = {};
  let totalEmpty = 0;
  let totalReasoning = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      const key = `${r.kind}/${r.modelId}/ok=${r.ok}/empty=${(r.textChars ?? 0) === 0}`;
      byKey[key] = (byKey[key] ?? 0) + 1;
      if (r.finishReason) finishReasons[r.finishReason] = (finishReasons[r.finishReason] ?? 0) + 1;
      if ((r.textChars ?? 0) === 0) totalEmpty++;
      if ((r.reasoningChars ?? 0) > 0) totalReasoning++;
    } catch { /* skip */ }
  }
  console.log("Per-call kinds:", byKey);
  console.log("Finish reasons:", finishReasons);
  console.log(`Total empty completions: ${totalEmpty}`);
  console.log(`Total calls with non-empty reasoningText: ${totalReasoning}`);
  console.log(`Total records: ${lines.length}`);

  console.log("\n== First 5 raw records (head only) ==\n");
  for (const line of lines.slice(0, 5)) {
    try {
      const r = JSON.parse(line);
      console.log(JSON.stringify({
        kind: r.kind, model: r.modelId, ok: r.ok,
        textChars: r.textChars, reasoningChars: r.reasoningChars,
        finishReason: r.finishReason,
        textHead: r.textHead?.slice(0, 80),
        reasoningHead: r.reasoningHead?.slice(0, 80),
        usage: r.usage, error: r.error,
      }, null, 2));
    } catch { /* skip */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
