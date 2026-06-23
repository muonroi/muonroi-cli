/**
 * EE SAMR Benchmark — đo latency classifyViaBrain cho SAMR routing.
 *
 * Mô phỏng các kịch bản task profile khác nhau để xác định:
 *   - p50 / p90 / p99 latency
 *   - Tỉ lệ timeout / lỗi
 *   - Có thể call cường độ cao (<500ms) cho 2b sub-agent tier override hay không
 *
 * Usage:
 *   bun run scripts/bench-ee-samr.mts
 *   MUONROI_EE_SAMR_TIMEOUT_MS=1000 bun run scripts/bench-ee-samr.mts
 */

import { performance } from "node:perf_hooks";

const WARMUP = 3;   // số lần warm-up trước khi đo
const ITERS = 20;   // số lần đo cho mỗi profile
const TIMEOUT_MS = Number(process.env.MUONROI_EE_SAMR_TIMEOUT_MS ?? 2000);

interface Profile {
  label: string;
  userMessage: string;
  taskType: string | null;
  complexitySize?: string;
  taskComplexity?: string;
  /** Expected: true nếu EE nên trả về samr=true */
  expectsSamr: boolean;
}

const PROFILES: Profile[] = [
  {
    label: "complex-refactor",
    userMessage: "Refactor the step-router module to support dynamic model tier selection based on task complexity and prior success rates. The current implementation uses a hardcoded tier map.",
    taskType: "refactor",
    complexitySize: "large",
    taskComplexity: "high",
    expectsSamr: true,
  },
  {
    label: "simple-docs",
    userMessage: "Add a docstring to the resolveExecutionModel function explaining the fallback chain.",
    taskType: "documentation",
    complexitySize: "small",
    taskComplexity: "low",
    expectsSamr: false,
  },
  {
    label: "plan-feature",
    userMessage: "Plan the implementation of a multi-step CI/CD pipeline that builds, tests, and deploys the agent harness packages across Windows and Linux matrices.",
    taskType: "plan",
    complexitySize: "medium",
    taskComplexity: "medium",
    expectsSamr: true, // EE decides, but heuristic fallback might not fire for medium
  },
  {
    label: "analyze-debug",
    userMessage: "Analyze this test failure: expected 10 passed but got 3 passed, 7 failed. The failing specs all hang at the same wait_for step. Logs show no event emitted after the 3rd frame.",
    taskType: "analyze",
    complexitySize: "medium",
    taskComplexity: "high",
    expectsSamr: true,
  },
  {
    label: "general-build",
    userMessage: "Run the build command and report any TypeScript errors in the output.",
    taskType: "build",
    complexitySize: "small",
    taskComplexity: "low",
    expectsSamr: false,
  },
  {
    label: "chitchat",
    userMessage: "Hello, how are you today? Can you help me understand what this project does?",
    taskType: "chitchat",
    complexitySize: undefined,
    taskComplexity: undefined,
    expectsSamr: false, // mechanical → heuristic skip, không cần EE
  },
];

interface RunResult {
  profile: string;
  iteration: number;
  durationMs: number;
  response: string | null;
  parsed: boolean;
  decision: "samr" | "no-samr" | "fallback" | "error";
}

async function runProfile(profile: Profile): Promise<RunResult[]> {
  // Dynamic import để EE bridge lazy-load (giống eeSamrGuidance thật)
  const { classifyViaBrain } = await import("../src/ee/bridge.js");

  const results: RunResult[] = [];

  // Warm-up
  for (let i = 0; i < WARMUP; i++) {
    try {
      await classifyViaBrain(`Warmup ${i}`, TIMEOUT_MS);
    } catch { /* ignore */ }
  }

  // Measurement
  for (let i = 0; i < ITERS; i++) {
    const prompt = [
      `Task: ${profile.userMessage.slice(0, 200)}`,
      `Context: type=${profile.taskType ?? "unknown"} complexity=${profile.taskComplexity ?? "unknown"} size=${profile.complexitySize ?? "unknown"}`,
      `Question: Would splitting the work into (1) premium reasoning then (2) cheap execution save tokens without hurting quality?`,
      `Reply valid JSON: {"samr":true,"executionTier":"balanced"} or {"samr":false}`,
    ].join("\n");

    const start = performance.now();
    let response: string | null = null;
    let parsed = false;
    let decision: RunResult["decision"] = "error";

    try {
      response = await classifyViaBrain(prompt, TIMEOUT_MS);
      const durationMs = performance.now() - start;

      if (!response) {
        decision = "fallback";
      } else {
        const parsedJson = JSON.parse(response) as Record<string, unknown>;
        parsed = true;
        decision = parsedJson.samr === true ? "samr" : "no-samr";
      }

      results.push({ profile: profile.label, iteration: i, durationMs, response, parsed, decision });
    } catch (err) {
      const durationMs = performance.now() - start;
      results.push({
        profile: profile.label,
        iteration: i,
        durationMs,
        response: `ERROR: ${(err as Error).message}`,
        parsed: false,
        decision: "error",
      });
    }
  }

  return results;
}

function computeStats(values: number[], label: string): void {
  if (values.length === 0) return;
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  console.log(`  ${label}: min=${min.toFixed(0)}ms p50=${p50.toFixed(0)}ms p90=${p90.toFixed(0)}ms p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms mean=${mean.toFixed(0)}ms`);
}

async function initEE(): Promise<void> {
  // KHỞI TẠO EE: load auth token + detect client mode
  // Nếu không làm step này, getCachedServerBaseUrl() luôn trả về null
  // và classifyViaBrain sẽ skip HTTP thin-client path.
  const { loadEEAuthToken } = await import("../src/ee/auth.js");
  const { detectEEClientMode, describeMode } = await import("../src/ee/client-mode.js");
  await loadEEAuthToken();
  const modeInfo = await detectEEClientMode({ force: true });
  console.log(`  EE mode: ${describeMode(modeInfo)}`);
  console.log();
}

async function main(): Promise<void> {
  console.log(`EE SAMR Benchmark — ${ITERS} iterations/profile, timeout=${TIMEOUT_MS}ms, warmup=${WARMUP}\n`);

  await initEE();

  const allDurations: number[] = [];
  let totalCalls = 0;
  let totalErrors = 0;
  let totalTimeouts = 0;
  let totalFallbacks = 0;

  for (const profile of PROFILES) {
    console.log(`Profile: ${profile.label} (type=${profile.taskType}, expectsSamr=${profile.expectsSamr})`);
    console.log(`  Task: ${profile.userMessage.slice(0, 80)}...`);

    const results = await runProfile(profile);

    const durations = results.map((r) => r.durationMs);
    computeStats(durations, "Latency");

    const decisions = results.map((r) => r.decision);
    const samrCount = decisions.filter((d) => d === "samr").length;
    const noSamrCount = decisions.filter((d) => d === "no-samr").length;
    const fallbackCount = decisions.filter((d) => d === "fallback").length;
    const errorCount = decisions.filter((d) => d === "error").length;

    // Timeout detection: dùng classifyViaBrain null response = fallback, duration > TIMEOUT_MS
    const timeoutCount = results.filter((r) => r.durationMs >= TIMEOUT_MS * 0.9).length;

    console.log(`  Decisions: samr=${samrCount} no-samr=${noSamrCount} fallback=${fallbackCount} error=${errorCount}`);
    if (timeoutCount > 0) console.log(`  ⚠  Near-timeout (>=${TIMEOUT_MS * 0.9}ms): ${timeoutCount}/${ITERS}`);
    console.log();

    allDurations.push(...durations);
    totalCalls += results.length;
    totalErrors += errorCount;
    totalTimeouts += timeoutCount;
    totalFallbacks += fallbackCount;
  }

  // Summary
  console.log("─".repeat(60));
  console.log(`Tổng: ${totalCalls} calls, ${totalErrors} errors, ${totalTimeouts} near-timeouts, ${totalFallbacks} fallbacks`);
  console.log();

  computeStats(allDurations, "All profiles");
  console.log();

  // Verdict
  const p99 = [...allDurations].sort((a, b) => a - b)[Math.floor(allDurations.length * 0.99)];
  const p90 = [...allDurations].sort((a, b) => a - b)[Math.floor(allDurations.length * 0.9)];

  if (p99 < 1200) {
    console.log("✅ KẾT LUẬN: EE latency rất thấp (p99 < 1200ms). Hoàn toàn có thể high-frequency call cho 2b.");
  } else if (p90 < 1500) {
    console.log("⚠️  KẾT LUẬN: EE latency chấp nhận được (p90 < 1500ms). Có thể call cho 2b nhưng nên cache kết quả.");
  } else if (p90 < TIMEOUT_MS) {
    console.log("🔴 KẾT LUẬN: EE latency cao. Không nên call realtime mà nên dùng heuristic fallback là chính, EE chỉ để tune dần.");
  } else {
    console.log("❌ KẾT LUẬN: EE thường xuyên timeout. 2b không thể dùng EE realtime — cần fallback toàn bộ.");
  }

  console.log();
  console.log("Gợi ý nếu cần tối ưu:");
  console.log("  - Set MUONROI_EE_SAMR_TIMEOUT_MS=500 để fallback nhanh");
  console.log("  - Bật heuristic filter trước (đã làm trong eeSamrGuidance)");
  console.log("  - Cache kết quả EE trong session (taskHash → decision)");
  console.log("  - Nếu p99 > 2000ms: dùng categorize locally + EE chỉ để confirm");
}

main().catch(console.error);
