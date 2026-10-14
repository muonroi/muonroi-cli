const fs = require("node:fs");
const path = require("node:path");
(async () => {
  process.env.MUONROI_PIL_DISCOVERY = "1";
  process.env.MUONROI_TEST_PIPELINE_TIMEOUT_MS = "25";
  const { runPipeline } = await import("../../../../dist/src/pil/pipeline.js");
  const { withPilExecutionBudget } = await import("../../../../dist/src/pil/timeout.js");
  const cases = [];
  for (const interactive of [false, true]) {
    const started = Date.now();
    const result = await runPipeline("Prepare a repair plan.", {
      llmFallback: () => new Promise(() => {}),
      ...(interactive
        ? {
            interactionHandler: {
              askQuestion: async () => {
                throw new Error("No interview before classification");
              },
            },
          }
        : {}),
    });
    cases.push({ interactive, elapsedMs: Date.now() - started, fallbackReason: result.fallbackReason });
  }
  const started = Date.now();
  const answer = await withPilExecutionBudget(async (budget) => {
    await budget.waitForUser(() => new Promise((resolve) => setTimeout(resolve, 250)));
    return "answered";
  }, 50);
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const cancelled = withPilExecutionBudget(() => new Promise(() => {}), 1000, controller.signal).then(
    () => "unexpected success",
    (err) => err.message,
  );
  controller.abort(new Error("request cancelled"));
  const report = {
    runtime: process.versions.bun ? "Bun" : "Node",
    cases,
    humanWait: { answer, elapsedMs: cancelStarted - started, budgetMs: 50 },
    cancel: { message: await cancelled, elapsedMs: Date.now() - cancelStarted },
  };
  fs.writeFileSync(
    path.join(__dirname, "pil-fixed-probe-" + report.runtime.toLowerCase() + ".json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(
    cases.every((x) => x.fallbackReason === "pipeline-timeout" && x.elapsedMs < 500) &&
      answer === "answered" &&
      report.cancel.message === "request cancelled"
      ? 0
      : 1,
  );
})().catch((err) => {
  console.error("Fixed PIL probe failed:", err.message);
  process.exit(1);
});
