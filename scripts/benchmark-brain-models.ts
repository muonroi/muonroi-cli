/**
 * Benchmark SiliconFlow models for task complexity classification.
 * Tests accuracy and latency across all candidate models.
 */

const API_KEY = "sk-rnqvvxycuvmztbwyenxoictwmhnquaecmulxwalcgoipphsl";
const ENDPOINT = "https://api.siliconflow.com/v1/chat/completions";

const SYSTEM = "You classify coding task complexity. Reply with exactly one word: fast, balanced, or premium. Nothing else.";

const TEST_CASES: Array<[string, string]> = [
  // English - fast
  ["hello", "fast"],
  ["hi there", "fast"],
  ["list all files in src/", "fast"],
  ["run bun test", "fast"],
  ["what does this function do?", "fast"],
  ["git status", "fast"],
  ["fix the typo in README.md", "fast"],
  ["read file package.json", "fast"],
  ["explain this error message", "fast"],
  // English - balanced
  ["fix the authentication bug in login.ts and update the tests", "balanced"],
  ["add a new API endpoint for user profiles with validation", "balanced"],
  ["refactor the payment module to use async/await", "balanced"],
  ["implement search functionality for the product page", "balanced"],
  // English - premium
  ["design a microservice architecture for the notification system with event sourcing", "premium"],
  ["architect a real-time collaboration feature with WebSocket and CRDT", "premium"],
  ["redesign the entire auth system with OAuth2, SSO, and role-based access control", "premium"],
  // Vietnamese - fast
  ["xin chào", "fast"],
  ["đọc file README.md", "fast"],
  ["chạy test", "fast"],
  ["sửa lỗi typo trong config", "fast"],
  ["giải thích hàm này làm gì", "fast"],
  // Vietnamese - balanced
  ["sửa lỗi đăng nhập và cập nhật unit test", "balanced"],
  ["thêm tính năng tìm kiếm cho trang sản phẩm", "balanced"],
  ["tái cấu trúc module thanh toán sang async/await", "balanced"],
  // Vietnamese - premium
  ["thiết kế lại kiến trúc database để hỗ trợ multi-tenant với data isolation", "premium"],
  ["xây dựng hệ thống CI/CD pipeline tự động deploy lên kubernetes với rollback", "premium"],
];

// Models to test — text chat models sorted by size (small → large)
const MODELS = [
  // Small / fast
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen3-8B",
  "Qwen/Qwen3-14B",
  // Medium
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
  "Qwen/Qwen3-32B",
  "Qwen/Qwen2.5-72B-Instruct",
  // Large / smart
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "deepseek-ai/DeepSeek-V3",
  "deepseek-ai/DeepSeek-V3.1",
  // Specialized
  "Qwen/Qwen3-Coder-30B-A3B-Instruct",
];

async function classify(model: string, task: string): Promise<{ result: string | null; ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Task: ${task}\nComplexity:` },
        ],
        max_tokens: 10,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { result: null, ms: Date.now() - start };
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content?.trim()?.toLowerCase() ?? null;
    // Normalize: extract first word that matches
    const match = content?.match(/\b(fast|balanced|premium)\b/);
    return { result: match ? match[1] : content, ms: Date.now() - start };
  } catch {
    return { result: null, ms: Date.now() - start };
  }
}

async function benchmarkModel(model: string): Promise<{
  model: string;
  correct: number;
  total: number;
  accuracy: number;
  avgMs: number;
  errors: number;
  details: Array<{ task: string; expected: string; got: string | null; ms: number }>;
}> {
  const details: Array<{ task: string; expected: string; got: string | null; ms: number }> = [];
  let correct = 0;
  let errors = 0;
  let totalMs = 0;

  for (const [task, expected] of TEST_CASES) {
    await new Promise((r) => setTimeout(r, 300)); // rate limit buffer
    const { result, ms } = await classify(model, task);
    totalMs += ms;
    if (result === null) {
      errors++;
    } else if (result === expected) {
      correct++;
    }
    details.push({ task, expected, got: result, ms });
  }

  const total = TEST_CASES.length;
  return {
    model,
    correct,
    total,
    accuracy: correct / total,
    avgMs: Math.round(totalMs / total),
    errors,
    details,
  };
}

// Main
console.log(`\nBenchmarking ${MODELS.length} models × ${TEST_CASES.length} test cases...\n`);

const results: Awaited<ReturnType<typeof benchmarkModel>>[] = [];

for (const model of MODELS) {
  process.stdout.write(`Testing ${model}...`);
  const r = await benchmarkModel(model);
  results.push(r);
  console.log(` ${(r.accuracy * 100).toFixed(0)}% (${r.correct}/${r.total}) avg:${r.avgMs}ms err:${r.errors}`);
}

// Sort by accuracy desc, then avgMs asc
results.sort((a, b) => b.accuracy - a.accuracy || a.avgMs - b.avgMs);

console.log("\n" + "=".repeat(100));
console.log("RANKING");
console.log("=".repeat(100));
console.log("Rank  Model".padEnd(55) + "Accuracy   Avg(ms)  Errors");
console.log("-".repeat(100));
results.forEach((r, i) => {
  console.log(
    `#${i + 1}`.padEnd(6) +
    r.model.padEnd(49) +
    `${(r.accuracy * 100).toFixed(0)}%`.padEnd(11) +
    `${r.avgMs}ms`.padEnd(9) +
    `${r.errors}`,
  );
});

// Show misclassifications for top 3
console.log("\n" + "=".repeat(100));
console.log("TOP 3 — MISCLASSIFICATIONS");
console.log("=".repeat(100));
for (const r of results.slice(0, 3)) {
  const misses = r.details.filter((d) => d.got !== d.expected);
  if (misses.length === 0) {
    console.log(`\n${r.model}: PERFECT — 0 misses`);
  } else {
    console.log(`\n${r.model}: ${misses.length} misses`);
    for (const m of misses) {
      const display = m.task.length > 60 ? m.task.slice(0, 57) + "..." : m.task;
      console.log(`  ❌ "${display}" expected:${m.expected} got:${m.got ?? "ERROR"} (${m.ms}ms)`);
    }
  }
}
