/**
 * E2E harness for PIL chitchat detection + MCP skip wiring.
 *
 * Runs runPipeline against realistic prompts (EN/VN, short/long, task/chitchat)
 * and prints intentKind / taskType / layer-skip flags. No LLM calls — purely
 * exercises the PIL pipeline + downstream gating logic the orchestrator uses.
 *
 * Run: bun run scripts/e2e-pil.ts
 */

import {
  applyPilSuffix,
  getResponseToolSet,
  isImplementationIntent,
  isMetaAnalysisPrompt,
  prefersStructuredReport,
} from "../src/pil/layer6-output.js";
import { runPipeline } from "../src/pil/pipeline.js";

interface Case {
  label: string;
  prompt: string;
  expectChitchat: boolean;
  notes?: string;
}

const CASES: Case[] = [
  // English chitchat — must be classified chitchat (hot-path)
  { label: "EN/chitchat/hi", prompt: "hi", expectChitchat: true, notes: "2 chars, 1 word" },
  { label: "EN/chitchat/hello", prompt: "hello", expectChitchat: true, notes: "5 chars, 1 word" },
  { label: "EN/chitchat/ok", prompt: "ok", expectChitchat: true },
  { label: "EN/chitchat/thanks", prompt: "thanks", expectChitchat: true },
  { label: "EN/chitchat/ty", prompt: "ty", expectChitchat: true },

  // Vietnamese chitchat
  { label: "VN/chitchat/chào", prompt: "chào", expectChitchat: true },
  { label: "VN/chitchat/ok", prompt: "ok bạn", expectChitchat: true, notes: "2 words, <10 chars" },

  // Short but task-flavored — must NOT be chitchat (Pass 1 keyword wins)
  { label: "EN/task/refactor", prompt: "refactor this", expectChitchat: false, notes: "keyword wins over hot-path" },
  { label: "EN/task/fix", prompt: "fix bug", expectChitchat: false, notes: "keyword 'fix'" },
  { label: "VN/task/sửa", prompt: "sửa lỗi", expectChitchat: false, notes: "keyword VN" },

  // Real coding tasks
  {
    label: "EN/task/long",
    prompt: "refactor the orchestrator to skip MCP loading for chitchat",
    expectChitchat: false,
  },
  { label: "VN/task/long", prompt: "viết test cho hàm enrichment ở layer 1", expectChitchat: false },
  { label: "EN/plan/long", prompt: "design a caching layer for the PIL pipeline", expectChitchat: false },
  { label: "EN/debug", prompt: "debug why interaction_logs has wrong duration", expectChitchat: false },

  // Edge cases
  {
    label: "EN/3words/short",
    prompt: "what is this",
    expectChitchat: false,
    notes: "3 words → fail hot-path; falls to brain (likely none → chitchat OR ambiguous)",
  },
  {
    label: "EN/empty",
    prompt: " ",
    expectChitchat: true,
    notes: "0 chars after trim → no task signal, treat as chitchat (MCP skip)",
  },
];

interface Row {
  label: string;
  prompt: string;
  taskType: string;
  intentKind: string;
  conf: string;
  outputStyle: string;
  layers: string;
  pilMs: number;
  ok: string;
  notes: string;
}

async function run(c: Case): Promise<Row> {
  const t0 = performance.now();
  const ctx = await runPipeline(c.prompt, { sessionId: null }).catch((err) => ({
    raw: c.prompt,
    enriched: c.prompt,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: 500,
    metrics: null,
    layers: [],
    intentKind: null,
    fallbackReason: `harness-catch:${err instanceof Error ? err.message : "unknown"}`,
  }));
  const pilMs = Math.round(performance.now() - t0);
  const isChitchat = ctx.intentKind === "chitchat";
  const ok = isChitchat === c.expectChitchat ? "OK" : "MISS";

  const appliedLayers = ctx.layers.filter((l) => l.applied).map((l) => l.name);
  const skippedLayers = ctx.layers.filter((l) => !l.applied && l.delta === "skip:chitchat").map((l) => l.name);
  const layersLine = `applied=[${appliedLayers.join(",")}] skip-chitchat=[${skippedLayers.join(",")}]`;

  return {
    label: c.label,
    prompt: JSON.stringify(c.prompt),
    taskType: String(ctx.taskType ?? "null"),
    intentKind: String(ctx.intentKind ?? "null"),
    conf: ctx.confidence.toFixed(2),
    outputStyle: String(ctx.outputStyle ?? "null"),
    layers: layersLine,
    pilMs,
    ok,
    notes: c.notes ?? "",
  };
}

async function main() {
  console.log("E2E PIL harness — chitchat detection + layer-skip wiring");
  console.log("=========================================================\n");

  const rows: Row[] = [];
  for (const c of CASES) {
    rows.push(await run(c));
  }

  // Pretty table
  for (const r of rows) {
    const flag = r.ok === "OK" ? "[32m✓[0m" : "[31m✗[0m";
    console.log(
      `${flag} ${r.label.padEnd(22)} ${r.prompt.padEnd(40)} → kind=${r.intentKind.padEnd(8)} task=${r.taskType.padEnd(13)} style=${r.outputStyle.padEnd(8)} ${r.pilMs}ms`,
    );
    console.log(`  ${r.layers}`);
    if (r.notes) console.log(`  note: ${r.notes}`);
    console.log();
  }

  const passed = rows.filter((r) => r.ok === "OK").length;
  const total = rows.length;
  console.log(`Result: ${passed}/${total} cases match expectation.`);
  if (passed !== total) {
    console.log("\nMisses:");
    for (const r of rows.filter((r) => r.ok !== "OK")) {
      console.log(`  - ${r.label}: prompt=${r.prompt} expected chitchat? but got intentKind=${r.intentKind}`);
    }
    process.exit(1);
  }

  // PIL-04 Tier 1 verification: prove suffix + tool gating fire end-to-end.
  console.log("\n=========================================================");
  console.log("PIL-04 Tier 1 verification — suffix shape + tool gating");
  console.log("=========================================================\n");

  // Narrow gating (de-robotizing): debug/analyze/plan QUESTIONS take the natural
  // markdown path; the structured respond_* tool is reserved for explicit
  // report/list/plan requests. `general` always keeps its (markdown-rendered)
  // tool. Cases pair a report-style prompt (tool expected) with a question/code
  // prompt (natural path). Classification is keyword-driven by runPipeline, so
  // expectations are DERIVED from the resolved ctx + the same public predicates
  // the orchestrator uses — not from a hardcoded taskType guess.
  const RESPONSE_TASK_TYPES = new Set(["analyze", "plan", "debug", "general"]);
  const tierCases = [
    { label: "analyze (report)", prompt: "analyze the orchestrator and list all cost-leak findings" },
    { label: "plan (report)", prompt: "plan the auth migration step by step" },
    { label: "analyze (question)", prompt: "write tests for the enrichment function" },
    { label: "plan (design)", prompt: "design a caching layer for the PIL pipeline" },
    { label: "generate", prompt: "scaffold a new express route for /users" },
    { label: "refactor", prompt: "refactor the orchestrator stream loop" },
    { label: "debug", prompt: "fix the bug in interaction_logs duration" },
    { label: "chitchat (hi)", prompt: "hi" },
  ];

  let tierFails = 0;
  for (const c of tierCases) {
    const ctx = await runPipeline(c.prompt, { sessionId: null });
    const suffix = applyPilSuffix("", ctx);
    const toolKeys = Object.keys(getResponseToolSet(ctx));

    const hasBudget = /OUTPUT BUDGET: aim for ≤(\d+) tokens/.exec(suffix);
    const hasNoPreamble = /FORBIDDEN OPENERS/.test(suffix);
    const isChitchat = ctx.intentKind === "chitchat";
    const isMeta = isMetaAnalysisPrompt(ctx.raw);
    const tt = ctx.taskType;

    // Expected gating, derived from the documented narrow-gating rules:
    //   tool IFF (eligible task type) ∧ ¬implementation-intent ∧
    //            (general ∨ explicit report/list/plan signal)
    const expectsTools =
      !isChitchat &&
      tt != null &&
      RESPONSE_TASK_TYPES.has(tt) &&
      !isImplementationIntent(ctx.raw) &&
      (tt === "general" || prefersStructuredReport(ctx.raw));

    // Expectations:
    //   chitchat → empty suffix, no tools
    //   structured (report/general) → respond_* registered
    //   natural path → no tools; budget + FORBIDDEN OPENERS unless meta-analysis
    //                  (meta deliberately relaxes both)
    let verdict = "OK";
    if (isChitchat) {
      if (suffix !== "" || toolKeys.length !== 0) verdict = "FAIL: chitchat should be empty";
    } else if (expectsTools) {
      if (toolKeys.length === 0) verdict = "FAIL: report/general turn should register response tool";
    } else {
      if (toolKeys.length !== 0) verdict = "FAIL: question/code turn should NOT register tools";
      else if (!isMeta && !hasBudget) verdict = "FAIL: missing budget hint";
      else if (!isMeta && !hasNoPreamble) verdict = "FAIL: missing FORBIDDEN OPENERS";
    }

    const flag = verdict === "OK" ? "[32m✓[0m" : "[31m✗[0m";
    console.log(
      `${flag} ${c.label.padEnd(15)} task=${String(ctx.taskType).padEnd(13)} kind=${String(ctx.intentKind).padEnd(8)} tools=[${toolKeys.join(",")}] budget=${hasBudget?.[1] ?? "-"} preamble-rule=${hasNoPreamble ? "yes" : "no"}`,
    );
    console.log(`   suffix.head: ${suffix.slice(0, 110).replace(/\n/g, "⏎")}${suffix.length > 110 ? "..." : ""}`);
    if (verdict !== "OK") {
      console.log(`   ${verdict}`);
      tierFails++;
    }
  }

  if (tierFails > 0) {
    console.log(`\nTier 1 verification: ${tierCases.length - tierFails}/${tierCases.length} pass.`);
    process.exit(1);
  }
  console.log(`\nTier 1 verification: ${tierCases.length}/${tierCases.length} pass.`);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
