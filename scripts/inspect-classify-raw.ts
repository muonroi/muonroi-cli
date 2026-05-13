#!/usr/bin/env bun
// Diagnostic for the 69% "none" task-type rate observed in baseline metrics.
//
// The brain handler calls classifyViaBrain with a "<category>,<style>" prompt
// and parses the response via case-insensitive substring match. When taskType
// ends up null, either:
//   1. The LLM returned text that contains none of the category tokens
//   2. The LLM returned empty/error
//   3. The substring match logic is too narrow
//
// This script calls /api/brain (raw LLM passthrough) with the SAME classifier
// prompt the handler uses, and prints the raw LLM output so we can see why
// matching fails.
//
// Usage:
//   bun scripts/inspect-classify-raw.ts
//   bun scripts/inspect-classify-raw.ts --prompt "your custom prompt"

import { getCachedAuthToken, getCachedServerBaseUrl, loadEEAuthToken } from "../src/ee/auth.js";

const FIXTURES = [
  "refactor this function to be async",
  "tại sao test fail?",
  "thiết kế hệ thống auth cho team",
  "hi",
  "phân tích lỗi memory leak",
  "write docs for the API endpoint",
  "generate a TypeScript Zod schema for User",
  "explain how OAuth works",
];

function buildClassifierPrompt(userPrompt: string): string {
  return (
    "You are a multilingual prompt classifier. The prompt may be in English, Vietnamese, or a mix.\n" +
    "Classify the prompt's INTENT (not its language). Reply with TWO lowercase words separated by a comma: <category>,<style>\n\n" +
    "Category — pick ONE:\n  refactor | debug | plan | analyze | documentation | generate | none\n\n" +
    "Style — pick ONE:\n  concise | balanced | detailed\n\n" +
    `Prompt: "${userPrompt.slice(0, 500)}"`
  );
}

function parseResult(raw: string): {
  taskType: string | null;
  outputStyle: string | null;
  matchedCategory: string | null;
  matchedStyle: string | null;
} {
  const lower = raw.toLowerCase();
  const cats = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];
  const matched = cats.find((c) => lower.includes(c));
  const styles = ["concise", "balanced", "detailed"];
  const styleMatched = styles.find((s) => lower.includes(s));

  let taskType: string | null = null;
  if (matched) {
    taskType = matched;
  } else if (/\bnone\b/.test(lower)) {
    taskType = "general";
  }
  return {
    taskType,
    outputStyle: styleMatched ?? null,
    matchedCategory: matched ?? null,
    matchedStyle: styleMatched ?? null,
  };
}

async function main() {
  await loadEEAuthToken();
  const baseUrl = getCachedServerBaseUrl();
  const token = getCachedAuthToken();
  if (!baseUrl || !token) {
    console.error("Need serverBaseUrl + token in ~/.experience/config.json");
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  let customPrompt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prompt" && argv[i + 1]) {
      customPrompt = argv[++i];
    }
  }

  const prompts = customPrompt ? [customPrompt] : FIXTURES;

  console.log(`\nClassifier raw-output inspector — ${baseUrl}/api/brain\n`);

  for (const userPrompt of prompts) {
    const classifierPrompt = buildClassifierPrompt(userPrompt);
    const started = Date.now();
    try {
      // Use /api/brain proxy — same path classifyViaBrain uses server-side.
      const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: classifierPrompt, maxTokens: 32, timeoutMs: 3000 }),
        signal: AbortSignal.timeout(5000),
      });
      const latency = Date.now() - started;
      if (!resp.ok) {
        console.log(`FAIL "${userPrompt.slice(0, 40)}"  HTTP ${resp.status}  ${latency}ms`);
        continue;
      }
      const body = (await resp.json()) as {
        ok?: boolean;
        result?: string;
        text?: string;
        content?: string;
        error?: string;
      };
      const rawText = body.result ?? body.text ?? body.content ?? "";
      const parsed = parseResult(rawText);
      const verdict = parsed.taskType ? "OK" : "MISS";
      console.log(`${verdict}  "${userPrompt.slice(0, 40)}"  ${latency}ms`);
      console.log(`     raw LLM output: ${JSON.stringify(rawText.slice(0, 200))}`);
      console.log(`     parsed: taskType=${parsed.taskType} style=${parsed.outputStyle}`);
      if (!parsed.taskType) {
        console.log(
          `     >> NO category token found in output. Substring search for [refactor|debug|plan|analyze|documentation|generate|none] missed.`,
        );
      }
      console.log("");
    } catch (err) {
      console.log(`ERROR "${userPrompt.slice(0, 40)}"  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
