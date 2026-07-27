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

/**
 * Resolve a slot's credentials + endpoint.
 *
 * A slot may name a backend that is NOT in the `ProviderId` union (SiliconFlow's
 * Qwen-VL is wired this way — the vision path is a hand-rolled fetch, so a
 * vision-only fallback needs no adapter, keychain entry, or settings screen).
 * Those slots carry `api_key_env` + `api_base` in the catalog; everything else
 * keeps going through the keychain and the provider endpoint table.
 */
async function resolveSlotTransport(slot: CatalogVisionProxySlot): Promise<{ apiKey: string; base: string } | null> {
  if (slot.api_key_env) {
    const key = process.env[slot.api_key_env]?.trim();
    if (!key) return null;
    return { apiKey: key, base: slot.api_base ?? apiBaseFor(slot.provider as ProviderId) };
  }
  try {
    const apiKey = await loadKeyForProvider(slot.provider as ProviderId);
    return { apiKey, base: slot.api_base ?? apiBaseFor(slot.provider as ProviderId) };
  } catch {
    return null;
  }
}

async function slotHasAvailableKey(slot: CatalogVisionProxySlot): Promise<boolean> {
  return (await resolveSlotTransport(slot)) !== null;
}

// ── Per-slot circuit breaker ────────────────────────────────────────────────
//
// Two failures are worth remembering rather than re-paying every single call:
//
//   • HTTP 429 from a pay-as-you-go vision model on a subscription key
//     (`glm-4.6v-flash` returns `code 1305` for every request on a GLM Coding
//     Plan key — permanent for that key, despite the "temporarily overloaded"
//     wording).
//   • HTTP 400 `code 1210 messages.content.type is invalid, allowed values:
//     ['text']` — the Z.ai *coding* endpoint does not accept image parts AT ALL,
//     so that slot can never serve vision no matter how many times we ask.
//
// Both were live on this machine, and together they made every image fail while
// the chain dutifully re-tried both dead slots on each request. A tripped slot
// is skipped until the cooldown expires (image-shape rejections get a long one:
// nothing about them is transient).
const slotBreaker = new Map<string, { until: number; reason: string }>();
const BREAKER_MS_TRANSIENT = 5 * 60_000;
const BREAKER_MS_SHAPE_REJECT = 60 * 60_000;

function slotKey(slot: CatalogVisionProxySlot): string {
  return `${slot.provider}/${slot.model_id}`;
}

/** True when the backend told us it cannot accept image content at all. */
function isImageShapeRejection(reason: string): boolean {
  return /content\.type is invalid|allowed values.*'text'|does not support (image|vision)|unsupported.*image/i.test(
    reason,
  );
}

function tripSlot(slot: CatalogVisionProxySlot, reason: string, opts?: { durable?: boolean }): void {
  if (opts?.durable) {
    // Caller already proved the slot cannot serve images (e.g. it answered
    // without seeing one) — no HTTP status will ever say so.
    slotBreaker.set(slotKey(slot), { until: Date.now() + BREAKER_MS_SHAPE_REJECT, reason });
    return;
  }
  // Only failures that will REPEAT are worth remembering. 5xx and network
  // faults stay eligible on the very next call — trip them and a blip demotes a
  // healthy primary for minutes.
  if (isImageShapeRejection(reason)) {
    // The endpoint does not accept image parts at all. Nothing transient here.
    slotBreaker.set(slotKey(slot), { until: Date.now() + BREAKER_MS_SHAPE_REJECT, reason });
    return;
  }
  // 429 on a vision slot is usually entitlement, not load (a pay-as-you-go model
  // called with a subscription key answers 429 forever); 401/403 is a bad key.
  // Neither self-heals within a turn.
  if (/HTTP (429|401|403)/.test(reason)) {
    slotBreaker.set(slotKey(slot), { until: Date.now() + BREAKER_MS_TRANSIENT, reason });
  }
}

function slotTrippedReason(slot: CatalogVisionProxySlot): string | null {
  const entry = slotBreaker.get(slotKey(slot));
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    slotBreaker.delete(slotKey(slot));
    return null;
  }
  return entry.reason;
}

/** Test seam — drops all breaker state. */
export function __resetVisionSlotBreaker(): void {
  slotBreaker.clear();
}

/**
 * Vision-proxy chain filtered to slots that currently have credentials AND are
 * not circuit-broken. Falls back to the key-only filter when the breaker would
 * empty the chain — a stale breaker must never turn "degraded" into "no vision".
 */
export async function resolveAvailableVisionChain(kind: VisionTaskKind = "default"): Promise<CatalogVisionProxySlot[]> {
  const keyed: CatalogVisionProxySlot[] = [];
  for (const slot of resolveVisionChain(kind)) {
    if (await slotHasAvailableKey(slot)) keyed.push(slot);
  }
  const healthy = keyed.filter((slot) => slotTrippedReason(slot) === null);
  return healthy.length > 0 ? healthy : keyed;
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

/**
 * Human setup hint derived from the catalog chain — never a hardcoded provider
 * list, which drifts the moment a slot is added (the old copy still said
 * "configure ZAI_API_KEY or XAI_API_KEY" after SiliconFlow was wired in).
 */
export function describeVisionSetup(kind: VisionTaskKind = "default"): string {
  const envs = [
    ...new Set(
      resolveVisionChain(kind).map(
        (slot) => slot.api_key_env ?? `${slot.provider.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      ),
    ),
  ];
  return `configure one of: ${envs.join(", ")}`;
}

export async function collectVisionUnavailableReasons(kind: VisionTaskKind = "default"): Promise<string[]> {
  const reasons: string[] = [];
  for (const slot of resolveVisionChain(kind)) {
    const tripped = slotTrippedReason(slot);
    if (tripped) {
      reasons.push(`${slot.model_id}@${slot.provider}: temporarily skipped after ${tripped}`);
    } else if (await slotHasAvailableKey(slot)) {
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
    return { ok: false, reason: `no vision backend available — ${describeVisionSetup()}` };
  }

  for (const slot of chain) {
    const provider = slot.provider as ProviderId;
    const transport = await resolveSlotTransport(slot);
    if (!transport) {
      failureReasons.push(`${slot.model_id}@${provider}: no API key`);
      continue;
    }
    const { apiKey, base } = transport;

    const result = await callVisionModelAt(base, wireModelId(slot), content, apiKey, signal, responseFormat);
    if (result.ok && isBlindResponse(result.text)) {
      // A 200 whose body says "I cannot see the image" is a FAILURE, not an
      // observation. The OpenCode Go proxy does exactly this: it accepts the
      // request, silently drops the image parts, and answers in prose. Treated as
      // success, that sentence is injected into the primary as its own direct
      // sight — the model then reasons about a picture nobody looked at, which is
      // strictly worse than a clean "vision unavailable".
      const reason = `backend answered without seeing the image (image parts dropped): ${result.text.slice(0, 120)}`;
      tripSlot(slot, "answers without seeing the image", { durable: true });
      failureReasons.push(`${slot.model_id}@${provider}: ${reason}`);
      console.warn(`[vision-backend] ${slot.model_id}@${provider} ${reason}, trying next...`);
      continue;
    }
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
      slotBreaker.delete(slotKey(slot));
      return { ok: true, text: result.text, model: slot.model_id, provider };
    }
    tripSlot(slot, result.reason);
    failureReasons.push(`${slot.model_id}@${provider}: ${result.reason}`);
    console.warn(`[vision-backend] ${slot.model_id}@${provider} failed (${result.reason}), trying next...`);
  }

  return { ok: false, reason: failureReasons.join(" | ") || "no vision backend configured" };
}

/**
 * Model id as the WIRE expects it. Catalog ids for the OpenCode Go proxy carry
 * an `opencode/` namespace that the endpoint itself rejects
 * (`Model opencode/glm-5.2 is not supported`). The adapter path already strips
 * it (`openai-compatible.ts`); this hand-rolled fetch did not, so every
 * opencode-go vision slot 401'd on the model name before the image was even
 * considered.
 */
function wireModelId(slot: CatalogVisionProxySlot): string {
  return slot.model_id.startsWith("opencode/") ? slot.model_id.slice("opencode/".length) : slot.model_id;
}

/**
 * True when the backend replied that it cannot see an image — while we were
 * holding one. Deliberately narrow: only first-person "I can't see/view the
 * image" shapes, so a legitimate observation about a blurry or cropped region
 * ("the text at the bottom is not legible") is NOT swallowed.
 */
function isBlindResponse(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 400) return false; // a real observation, whatever it also says
  // The OBJECT must be the image itself. "I cannot see the axis labels clearly"
  // is a legitimate observation about a low-resolution region and must survive.
  const cannotSeeTheImage =
    /\bi (cannot|can't|can not|am unable to|do not have the ability to|don't have the ability to)\s+(see|view|access|read|analyse|analyze|process)\s+(the |this |that |any |an |your )?(image|picture|screenshot|photo|attachment)\b/;
  const noImageAtAll = /\b(no image (was )?(provided|attached|received|included)|there (is|was) no image)\b/;
  return cannotSeeTheImage.test(t) || noImageAtAll.test(t);
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
  opts: { imageCount: number; cachedIds?: string[]; visionSessionId?: string },
): string {
  const subject = opts.imageCount > 1 ? `these ${opts.imageCount} images` : "this image";
  const cacheHint =
    opts.cachedIds && opts.cachedIds.length > 0
      ? `- Cached as ${opts.cachedIds.join(", ")} — use ask_vision_proxy with a specific question to inspect a detail`
      : "";
  // The image stays OPEN in a dedicated sub-session until the agent says done —
  // follow-ups are answered from what it already saw, so asking twice is cheap
  // and asking nothing costs a held-open session. Both facts belong in the
  // envelope, or the model will neither ask nor release.
  const sessionHint = opts.visionSessionId
    ? [
        `- The image is OPEN in vision session ${opts.visionSessionId}; ask_vision_proxy answers follow-ups from what it already saw (no re-read, no re-upload)`,
        `- Call vision_done with vision_session_id="${opts.visionSessionId}" once you no longer need to look at it`,
      ].join("\n")
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
    sessionHint,
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
    `Setup: ${describeVisionSetup()} for the vision proxy, or switch to a vision-capable default model.`,
    "- Retry with analyze_image and the file path once a vision key is configured",
    "- Use ask_vision_proxy if a cached image exists",
    "- Ask the user to re-share the screenshot or describe what you need to see",
    cacheHint,
    "</vision-observation>",
  ]
    .filter(Boolean)
    .join("\n");
}
