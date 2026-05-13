/**
 * Probe how reasoning-model responses come through:
 *  1) Raw SSE via curl-equivalent — what fields does the provider send?
 *  2) AI SDK v6 fullStream — what chunk types come through after parsing?
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";

const PROMPT = "What is 2+2? Answer in one short sentence.";

async function rawSseProbe(label: string, baseURL: string, apiKey: string, model: string) {
  console.log(`\n══ ${label} — RAW SSE (first 6 events) ══`);
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
      max_tokens: 200,
    }),
  });
  if (!res.ok) {
    console.log(`  HTTP ${res.status} — ${await res.text().then((t) => t.slice(0, 200))}`);
    return;
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let count = 0;
  while (count < 6) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const json = JSON.parse(line.slice(6));
        const delta = json.choices?.[0]?.delta ?? json.choices?.[0]?.message ?? {};
        const keys = Object.keys(delta);
        console.log(`  [${count}] keys=${JSON.stringify(keys)}`, JSON.stringify(delta).slice(0, 200));
        count++;
        if (count >= 6) break;
      } catch {}
    }
  }
  reader.releaseLock();
}

async function sdkProbe(label: string, baseURL: string, apiKey: string, model: string) {
  console.log(`\n══ ${label} — AI SDK v6 fullStream chunk types ══`);
  const provider = createOpenAICompatible({ name: "probe", baseURL, apiKey });
  const result = streamText({
    model: provider(model),
    messages: [{ role: "user", content: PROMPT }],
  });
  const typeCounts: Record<string, number> = {};
  let textSample = "";
  let reasoningSample = "";
  for await (const chunk of result.fullStream) {
    typeCounts[chunk.type] = (typeCounts[chunk.type] ?? 0) + 1;
    if (chunk.type === "text-delta" && textSample.length < 80) textSample += (chunk as any).text ?? "";
    if (chunk.type.includes("reasoning") && reasoningSample.length < 120) {
      reasoningSample += (chunk as any).text ?? (chunk as any).reasoning ?? "";
    }
  }
  console.log("  chunk types:", typeCounts);
  console.log("  text sample:", JSON.stringify(textSample));
  console.log("  reasoning sample:", JSON.stringify(reasoningSample));
}

async function main() {
  const sfKey = process.env.SILICONFLOW_API_KEY;
  const dsKey = process.env.DEEPSEEK_API_KEY;

  if (sfKey) {
    const baseURL = "https://api.siliconflow.com/v1";
    await rawSseProbe("SiliconFlow / DeepSeek-V4-Flash", baseURL, sfKey, "deepseek-ai/DeepSeek-V4-Flash");
    await sdkProbe("SiliconFlow / DeepSeek-V4-Flash", baseURL, sfKey, "deepseek-ai/DeepSeek-V4-Flash");
  } else {
    console.log("SILICONFLOW_API_KEY not set — skipping.");
  }

  if (dsKey) {
    const baseURL = "https://api.deepseek.com/v1";
    await rawSseProbe("DeepSeek official / deepseek-reasoner", baseURL, dsKey, "deepseek-reasoner");
    await sdkProbe("DeepSeek official / deepseek-reasoner", baseURL, dsKey, "deepseek-reasoner");
  } else {
    console.log("\nDEEPSEEK_API_KEY not set — skipping DeepSeek official.");
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
