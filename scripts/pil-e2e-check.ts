// Quick E2E check for the 6-layer PIL pipeline (run via bun).
import { loadEEAuthToken } from "../src/ee/auth.js";
import { detectEEClientMode } from "../src/ee/client-mode.js";
import { runPipeline } from "../src/pil/pipeline.js";

await loadEEAuthToken();
const mode = await detectEEClientMode();
console.log(`[probe] EE mode = ${mode.mode} (${mode.serverBaseUrl ?? "no-server"})`);

const PROMPTS = [
  {
    label: "refactor (TS code block)",
    text: "Refactor this function to be async:\n```ts\nfunction foo() { return 1; }\n```",
  },
  {
    label: "debug (keyword fallback)",
    text: "Tests are failing with TypeError: cannot read property 'x' of undefined",
  },
  { label: "plan (keyword fallback)", text: "Plan the architecture for a new licensing service with phases" },
  { label: "documentation (keyword)", text: "Add JSDoc comments to this module" },
  { label: "explain", text: "Explain how the orchestrator works" },
  { label: "create-file", text: "Create a new file src/foo.ts with a hello world export" },
  { label: "short / general", text: "hi" },
  { label: "vietnamese conversational", text: "tôi muốn check xem 6 layer pil có chạy đúng không" },
  { label: "vietnamese debug", text: "sửa lỗi compile trong file foo.ts" },
  { label: "vietnamese refactor", text: "tái cấu trúc function này cho gọn hơn" },
  { label: "no-match (long prose)", text: "I have been pondering the philosophical implications of agentic systems" },
];

for (const p of PROMPTS) {
  const t0 = Date.now();
  const ctx = await runPipeline(p.text);
  const wall = Date.now() - t0;
  console.log("══════════════════════════════════════════════");
  console.log(
    `PROMPT: ${p.label}  wall=${wall}ms  pipeMs=${ctx.metrics?.totalMs ?? "n/a"}  fb=${ctx.fallbackReason ?? "—"}`,
  );
  console.log(`  taskType=${ctx.taskType}  domain=${ctx.domain}  conf=${ctx.confidence}  style=${ctx.outputStyle}`);
  console.log(`  raw=${ctx.raw.length} → enriched=${ctx.enriched.length}  Δ=${ctx.enriched.length - ctx.raw.length}`);
  for (const l of ctx.layers) {
    console.log(`    - ${l.name}: applied=${l.applied} delta=${l.delta ?? "—"}`);
  }
  if (ctx.metrics?.layerTimings) {
    console.log(`  timings: ${ctx.metrics.layerTimings.map((t) => `${t.name}=${t.ms}ms`).join(", ")}`);
  }
}
