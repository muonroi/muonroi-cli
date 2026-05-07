/**
 * Vision proxy layer for text-only models (e.g. DeepSeek V4).
 *
 * When the active model does not support vision, image parts in the message
 * are extracted, sent to a cheap vision model on SiliconFlow
 * (Qwen/Qwen2.5-VL-32B-Instruct @ $0.27/M tokens), and replaced with
 * structured text descriptions before the message reaches the primary model.
 */

import type { ModelMessage } from "ai";
import { getModelInfo } from "../models/registry.js";
import { apiBaseFor } from "./endpoints.js";
import { loadKeyForProvider } from "./keychain.js";

const VISION_MODELS = [
  "Qwen/Qwen3-VL-8B-Instruct",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
  "Qwen/Qwen3-VL-32B-Instruct",
] as const;
const SILICONFLOW_BASE = apiBaseFor("siliconflow");
const REQUEST_TIMEOUT_MS = 90_000;

interface ImagePart {
  type: "image";
  image: string; // base64
  mediaType: string;
}

interface TextPart {
  type: "text";
  text: string;
}

type ContentPart = TextPart | ImagePart;

export interface VisionProxyResult {
  messages: ModelMessage[];
  proxied: boolean;
  imageCount: number;
}

/**
 * Returns true when the model cannot handle image content natively.
 */
export function needsVisionProxy(modelId: string): boolean {
  const info = getModelInfo(modelId);
  return info?.supportsVision === false;
}

/**
 * Process messages through the vision proxy.
 * Only messages with image parts are modified; text-only messages pass through.
 */
export async function proxyVision(
  messages: ModelMessage[],
  modelId: string,
  signal?: AbortSignal,
): Promise<VisionProxyResult> {
  if (!needsVisionProxy(modelId)) {
    return { messages, proxied: false, imageCount: 0 };
  }

  let totalImages = 0;
  const processed: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content === "string") {
      processed.push(msg);
      continue;
    }

    const parts = msg.content as ContentPart[];
    const hasImages = parts.some((p) => p.type === "image");
    if (!hasImages) {
      processed.push(msg);
      continue;
    }

    const imageParts = parts.filter((p): p is ImagePart => p.type === "image");
    const textParts = parts.filter((p): p is TextPart => p.type === "text");
    totalImages += imageParts.length;

    const descriptions = await describeImages(imageParts, textParts, signal);

    const newContent = [
      ...textParts,
      { type: "text" as const, text: descriptions },
    ];
    processed.push({ ...msg, content: newContent });
  }

  return { messages: processed, proxied: totalImages > 0, imageCount: totalImages };
}

async function describeImages(
  images: ImagePart[],
  contextTexts: TextPart[],
  signal?: AbortSignal,
): Promise<string> {
  let apiKey: string;
  try {
    apiKey = await loadKeyForProvider("siliconflow");
  } catch {
    return buildFallbackDescription(images, ["SILICONFLOW_API_KEY not configured"]);
  }

  const userContext = contextTexts.map((t) => t.text).join("\n");

  const visionContent: Array<Record<string, unknown>> = [];
  visionContent.push({
    type: "text",
    text: buildAnalysisPrompt(userContext, images.length),
  });

  for (const img of images) {
    visionContent.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType};base64,${img.image}`,
        detail: "high",
      },
    });
  }

  const failureReasons: string[] = [];
  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, visionContent, apiKey, signal);
      if (result.ok) return formatVisionResult(result.text, images.length, model);
      failureReasons.push(`${model}: ${result.reason}`);
      console.warn(`[vision-proxy] ${model} failed (${result.reason}), trying next...`);
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      failureReasons.push(`${model}: ${msg}`);
      console.warn(`[vision-proxy] ${model} threw (${msg}), trying next...`);
    }
  }

  return buildFallbackDescription(images, failureReasons);
}

type VisionCallResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

async function callVisionModel(
  model: string,
  content: Array<Record<string, unknown>>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VisionCallResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 2048,
        temperature: 0.1,
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
    const errText = await res.text().catch(() => "unknown error");
    return { ok: false, reason: `HTTP ${res.status} ${errText.slice(0, 200)}` };
  }

  const data = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: string } }> }
    | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { ok: false, reason: "empty response body" };
  return { ok: true, text };
}

function buildAnalysisPrompt(userContext: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `Analyze ${plural} for a software developer. The developer is working in a coding CLI tool.`,
    "Focus on:",
    "- UI layout and component structure (if screenshot)",
    "- All visible text, labels, buttons, and form elements",
    "- Colors, spacing, and visual hierarchy",
    "- Code visible in the image (transcribe exactly)",
    "- Error messages, console output, or terminal content",
    "- Any diagram, flowchart, or architectural sketch",
    "",
    "Be precise and structured. Use markdown formatting.",
    userContext ? `\nDeveloper's context: "${userContext}"` : "",
  ].join("\n");
}

function formatVisionResult(description: string, imageCount: number, model?: string): string {
  const usedModel = model ?? VISION_MODELS[0];
  const header = imageCount > 1
    ? `[Vision Proxy — ${imageCount} images analyzed via ${usedModel}]`
    : `[Vision Proxy — image analyzed via ${usedModel}]`;
  return `\n${header}\n${description}\n[/Vision Proxy]\n`;
}

function buildFallbackDescription(images: ImagePart[], reasons: string[] = []): string {
  const count = images.length;
  const types = [...new Set(images.map((i) => i.mediaType))].join(", ");
  const detail = reasons.length > 0
    ? `Reason(s): ${reasons.join(" | ")}`
    : "Reason: unknown — check SILICONFLOW_API_KEY and model availability.";
  return `\n[Vision Proxy — unavailable, ${count} image(s) (${types}) could not be analyzed. ${detail}]\n`;
}
