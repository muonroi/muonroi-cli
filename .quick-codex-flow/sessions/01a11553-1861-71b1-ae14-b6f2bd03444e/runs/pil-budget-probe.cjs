// Local fault injection: no provider calls, no production edits.
const fs = require("fs");
const path = require("path");
(async () => {
  process.env.MUONROI_PIL_DISCOVERY = "1";
  process.env.MUONROI_TEST_PIPELINE_TIMEOUT_MS = "25";
  const { runPipeline } = await import("../../../../dist/src/pil/pipeline.js");
  async function sample(interactive) {
    const started = Date.now();
    let outerTimer;
    const result = await Promise.race([
      runPipeline("Prepare a repair plan for the CLI audit.", {
        llmFallback: () => new Promise(() => {}),
        ...(interactive
          ? {
              interactionHandler: {
                askQuestion: async () => {
                  throw new Error("No interview expected before classification");
                },
              },
            }
          : {}),
      }).then((x) => ({ state: "resolved", fallbackReason: x.fallbackReason })),
      new Promise((resolve) => {
        outerTimer = setTimeout(() => resolve({ state: "still_pending_at_external_deadline" }), 150);
      }),
    ]);
    clearTimeout(outerTimer);
    return { interactive, pipelineBudgetMs: 25, elapsedMs: Date.now() - started, ...result };
  }
  const results = [await sample(false), await sample(true)];
  fs.writeFileSync(path.join(__dirname, "pil-budget-probe.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exit(
    results[0].fallbackReason === "pipeline-timeout" && results[1].state === "still_pending_at_external_deadline"
      ? 0
      : 1,
  );
})().catch((err) => {
  console.error("PIL budget probe failed:", err.message);
  process.exit(1);
});
