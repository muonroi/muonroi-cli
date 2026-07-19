/**
 * Catalog-driven vision proxy backend — replaces hardcoded SiliconFlow Qwen VL.
 * Used by vision-proxy.ts (message path) and mcp-vision-bridge.ts (tool path).
 */
import type { CatalogVisionProxyRouting, CatalogVisionProxySlot } from "../models/catalog-client.js";
import { getModelInfo, getVisionProxyRouting, MODELS, SWITCH_PROVIDER_ORDER } from "../models/registry.js";
import { recordUsageEvent } from "../storage/usage.js";
import { apiBaseFor } from "./endpoints.js";
import { loadKeyForProvider } from "./keychain.js";
import type { ProviderId } from "./types.js";

/**
 * Bước 2 / H2: the vision backend is a hand-rolled `fetch` — it does NOT resolve
 * through `resolveModelRuntime`, so the metered gate never sees it. To close the
 * bypass we capture the provider's own `usage` from the response and record it
 * under the `vision` usage source, making these calls visible to
 * `usage forensics` (previously the tokens were discarded entirely). Threaded
 * from callers that hold a session; a call with no session simply skips the row.
 */
export interface VisionCallMeta {
  sessionId?: string;
}

interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type VisionTaskKind = "default" | "ocr" | "design";

const REQUEST_TIMEOUT_MS = 90_000;

const DEFAULT_VISION_PROXY: CatalogVisionProxyRouting = {
  default: { provider: "zai", model_id: "glm-4.6v-flash" },
  ocr: { provider: "zai", model_id: "glm-4.6v-flash" },
  design: { provider: "zai", model_id: "glm-5.2" },
  fallback_chain: [
    { provider: "xai", model_id: "grok-4.5" },
    { provider: "zai", model_id: "glm-5.2" },
  ],
};

const OCR_INTENT_RE =
  /\b(ocr|transcribe|read\s+(all\s+)?text|extract\s+text|text\s+in\s+(the\s+)?image|copy\s+text|what\s+(does|do)\s+it\s+say)\b/i;

export function looksLikeOcrIntent(text: string): boolean {
  return OCR_INTENT_RE.test(text);
}

export function resolveVisionChain(kind: VisionTaskKind): CatalogVisionProxySlot[] {
  const routing = getVisionProxyRouting() ?? DEFAULT_VISION_PROXY;
  const chain: CatalogVisionProxySlot[] = [];
  const primary = routing[kind] ?? routing.default;
  if (primary) chain.push(primary);
  for (const slot of routing.fallback_chain ?? []) {
    if (!chain.some((s) => s.provider === slot.provider && s.model_id === slot.model_id)) {
      chain.push(slot);
    }
  }
  if (chain.length === 0 && routing.default) return [routing.default];
  return chain;
}

async function slotHasAvailableKey(slot: CatalogVisionProxySlot): Promise<boolean> {
  try {
    await loadKeyForProvider(slot.provider as ProviderId);
    return true;
  } catch {
    return false;
  }
}

/** Vision-proxy chain filtered to providers that currently have API keys. */
export async function resolveAvailableVisionChain(kind: VisionTaskKind = "default"): Promise<CatalogVisionProxySlot[]> {
  const available: CatalogVisionProxySlot[] = [];
  for (const slot of resolveVisionChain(kind)) {
    if (await slotHasAvailableKey(slot)) available.push(slot);
  }
  return available;
}

export async function isVisionBackendAvailable(kind: VisionTaskKind = "default"): Promise<boolean> {
  return (await resolveAvailableVisionChain(kind)).length > 0;
}

export interface NativeVisionFallback {
  modelId: string;
  provider: ProviderId;
  source: "vision_proxy_slot" | "catalog_vision";
}

async function tryNativeVisionModel(
  modelId: string,
  source: NativeVisionFallback["source"],
  excludeModelId?: string,
): Promise<NativeVisionFallback | null> {
  if (excludeModelId && modelId === excludeModelId) return null;
  const info = getModelInfo(modelId);
  if (!info?.supportsVision) return null;
  const provider = info.provider as ProviderId;
  const { isModelDisabled, isProviderDisabled } = await import("../utils/settings.js");
  if (isProviderDisabled(provider) || isModelDisabled(modelId)) return null;
  if (!(await slotHasAvailableKey({ provider, model_id: modelId }))) return null;
  return { modelId, provider, source };
}

/**
 * When vision-proxy backends have no keys, pick a catalog vision model (with key)
 * so images can be sent natively instead of failing on a text-only primary.
 */
export async function findNativeVisionFallback(opts?: {
  excludeModelId?: string;
}): Promise<NativeVisionFallback | null> {
  const exclude = opts?.excludeModelId;
  const seen = new Set<string>();

  for (const kind of ["default", "ocr", "design"] as VisionTaskKind[]) {
    for (const slot of resolveVisionChain(kind)) {
      if (seen.has(slot.model_id)) continue;
      seen.add(slot.model_id);
      const hit = await tryNativeVisionModel(slot.model_id, "vision_proxy_slot", exclude);
      if (hit) return hit;
    }
  }

  const visionByProvider = new Map<string, typeof MODELS>();
  for (const m of MODELS) {
    if (!m.supportsVision || !m.provider) continue;
    const list = visionByProvider.get(m.provider) ?? [];
    list.push(m);
    visionByProvider.set(m.provider, list);
  }

  for (const provider of SWITCH_PROVIDER_ORDER) {
    for (const m of visionByProvider.get(provider) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const hit = await tryNativeVisionModel(m.id, "catalog_vision", exclude);
      if (hit) return hit;
    }
  }

  for (const m of MODELS) {
    if (!m.supportsVision) continue;
    if (seen.has(m.id)) continue;
    const hit = await tryNativeVisionModel(m.id, "catalog_vision", exclude);
    if (hit) return hit;
  }

  return null;
}

export async function collectVisionUnavailableReasons(kind: VisionTaskKind = "default"): Promise<string[]> {
  const reasons: string[] = [];
  for (const slot of resolveVisionChain(kind)) {
    if (await slotHasAvailableKey(slot)) {
      reasons.push(`${slot.model_id}@${slot.provider}: API key present but backend unreachable`);
    } else {
      reasons.push(`${slot.model_id}@${slot.provider}: no API key`);
    }
  }
  reasons.push("no other vision-capable catalog model has a configured API key");
  return reasons;
}

export type VisionCallResult =
  | { ok: true; text: string; model: string; provider: string }
  | { ok: false; reason: string };

export async function callVisionBackend(
  chain: CatalogVisionProxySlot[],
  content: Array<Record<string, unknown>>,
  signal?: AbortSignal,
  responseFormat?: { type: "json_object" },
  meta?: VisionCallMeta,
): Promise<VisionCallResult> {
  const failureReasons: string[] = [];

  if (chain.length === 0) {
    return { ok: false, reason: "no vision backend available — configure ZAI_API_KEY or XAI_API_KEY" };
  }

  for (const slot of chain) {
    const provider = slot.provider as ProviderId;
    let apiKey: string;
    try {
      apiKey = await loadKeyForProvider(provider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failureReasons.push(`${slot.model_id}@${provider}: no API key (${msg})`);
      continue;
    }

    const base = apiBaseFor(provider);
    const result = await callVisionModelAt(base, slot.model_id, content, apiKey, signal, responseFormat);
    if (result.ok) {
      // H2: record the provider's own usage under the `vision` source so this
      // otherwise-invisible paid call shows up in `usage forensics`. Fail-open.
      if (meta?.sessionId && result.usage) {
        try {
          recordUsageEvent(meta.sessionId, "vision", slot.model_id, {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          });
        } catch {
          /* usage recording is best-effort — never break the vision call */
        }
      }
      return { ok: true, text: result.text, model: slot.model_id, provider };
    }
    failureReasons.push(`${slot.model_id}@${provider}: ${result.reason}`);
    console.warn(`[vision-backend] ${slot.model_id}@${provider} failed (${result.reason}), trying next...`);
  }

  return { ok: false, reason: failureReasons.join(" | ") || "no vision backend configured" };
}

type VisionHttpResult = { ok: true; text: string; usage?: VisionUsage } | { ok: false; reason: string };

async function callVisionModelAt(
  baseURL: string,
  model: string,
  content: Array<Record<string, unknown>>,
  apiKey: string,
  signal?: AbortSignal,
  responseFormat?: { type: "json_object" },
): Promise<VisionHttpResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 3072,
        temperature: 0.1,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (timedOut) return { ok: false, reason: `timeout after ${REQUEST_TIMEOUT_MS}ms` };
    if (signal?.aborted) throw err;
    return { ok: false, reason: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  clearTimeout(timeout);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { ok: false, reason: `HTTP ${res.status} ${errText.slice(0, 200)}` };
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  } | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { ok: false, reason: "empty response body" };
  // OpenAI-compatible usage block (H2). Absent on some backends → omit.
  const u = data?.usage;
  const usage: VisionUsage | undefined = u
    ? {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
      }
    : undefined;
  return { ok: true, text, usage };
}

/** Ask the vision model to write as direct sight for the primary (text-only) agent. */
export function wrapAnalyzerInstructions(userPrompt: string, kind: VisionTaskKind): string {
  const style =
    kind === "design"
      ? "Output ONLY valid JSON matching the requested schema. No markdown fences."
      : "Write in clear markdown. Use first-person present tense ('I see…', 'The screenshot shows…').";
  return [
    userPrompt,
    "",
    "IMPORTANT — output style for the primary coding agent:",
    "- Write as a DIRECT visual observation. The reader will treat your words as its own native sight.",
    "- Do NOT mention vision proxy, backend models, or that you are a separate model.",
    `- ${style}`,
    "- If something is illegible, cropped, or ambiguous, say exactly what is unclear and what would help (closer crop, higher resolution, different angle).",
  ].join("\n");
}

/**
 * Envelope injected into text-only model context — reads as native vision, not third-party analysis.
 */
export function formatNativeVisionObservation(
  observation: string,
  opts: { imageCount: number; cachedIds?: string[] },
): string {
  const subject = opts.imageCount > 1 ? `these ${opts.imageCount} images` : "this image";
  const cacheHint =
    opts.cachedIds && opts.cachedIds.length > 0
      ? `- Cached as ${opts.cachedIds.join(", ")} — use ask_vision_proxy with a specific question to inspect a detail`
      : "";

  return [
    "<vision-observation>",
    `You are viewing ${subject}. Treat everything below as your direct visual observation — reason and respond as if you saw it yourself.`,
    "",
    observation.trim(),
    "",
    "If any detail is unclear, cropped, or you need another angle:",
    "- ask_vision_proxy with a precise question (region, color, text, UI element)",
    "- analyze_image on the file path to re-inspect or compare a fresh screenshot",
    "- ask the user to share another image or clarify what to focus on",
    cacheHint,
    "</vision-observation>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function formatNativeVisionUnavailable(imageCount: number, reasons: string[], cachedIds?: string[]): string {
  const types = imageCount > 1 ? `${imageCount} images` : "1 image";
  const cacheHint =
    cachedIds && cachedIds.length > 0 ? `Cached IDs: ${cachedIds.join(", ")} — try ask_vision_proxy anyway.` : "";
  const detail = reasons.length > 0 ? reasons.join(" | ") : "vision backend unreachable";
  return [
    '<vision-observation status="unavailable">',
    `${types} could not be analyzed (${detail}).`,
    "Do NOT guess what the image contains.",
    "Setup: configure ZAI_API_KEY or XAI_API_KEY for vision proxy, or switch to a vision-capable default model.",
    "- Retry with analyze_image and the file path once a vision key is configured",
    "- Use ask_vision_proxy if a cached image exists",
    "- Ask the user to re-share the screenshot or describe what you need to see",
    cacheHint,
    "</vision-observation>",
  ]
    .filter(Boolean)
    .join("\n");
}
