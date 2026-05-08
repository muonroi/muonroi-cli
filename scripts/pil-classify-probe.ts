import { classify } from "../src/router/classifier/index.js";
import { runPipeline } from "../src/pil/pipeline.js";
import { PipelineContextSchema } from "../src/pil/schema.js";

const PROMPTS = [
  "hi",
  "Add JSDoc comments to this module",
  "I have been pondering the philosophical implications of agentic systems",
  "Refactor this function to be async:\n```ts\nfunction foo() { return 1; }\n```",
  "tôi muốn check xem 6 layer pil có chạy đúng không",
];

console.log("── classify() raw output ──");
for (const p of PROMPTS) {
  const r = classify(p);
  console.log(`  "${p.slice(0, 50)}"  →  reason=${r.reason}  conf=${r.confidence}`);
}

console.log("\n── runPipeline() + schema validity ──");
for (const p of PROMPTS) {
  const ctx = await runPipeline(p);
  const ok = PipelineContextSchema.safeParse(ctx);
  console.log(`  "${p.slice(0, 50)}"`);
  console.log(`    taskType=${ctx.taskType}  layers=${ctx.layers.length}  schema-valid=${ok.success}`);
  if (!ok.success) console.log(`    schema-error: ${JSON.stringify(ok.error.issues)}`);
}
