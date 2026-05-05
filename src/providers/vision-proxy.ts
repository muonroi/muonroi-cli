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
import { loadKeyForProvider } from "./keychain.js";

const VISION_MODEL = "Qwen/Qwen2.5-VL-32B-Instruct";
const SILICONFLOW_BASE = "https://api.siliconflow.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;

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
    return buildFallbackDescription(images);
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

  const body = {
    model: VISION_MODEL,
    messages: [{ role: "user", content: visionContent }],
    max_tokens: 2048,
    temperature: 0.1,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const res = await fetch(`${SILICONFLOW_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      console.warn(`[vision-proxy] SiliconFlow API error ${res.status}: ${errText}`);
      return buildFallbackDescription(images);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const description = data.choices?.[0]?.message?.content;
    if (!description) return buildFallbackDescription(images);

    return formatVisionResult(description, images.length);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[vision-proxy] request failed: ${err}`);
    return buildFallbackDescription(images);
  }
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

function formatVisionResult(description: string, imageCount: number): string {
  const header = imageCount > 1
    ? `[Vision Proxy — ${imageCount} images analyzed via ${VISION_MODEL}]`
    : `[Vision Proxy — image analyzed via ${VISION_MODEL}]`;
  return `\n${header}\n${description}\n[/Vision Proxy]\n`;
}

function buildFallbackDescription(images: ImagePart[]): string {
  const count = images.length;
  const types = [...new Set(images.map((i) => i.mediaType))].join(", ");
  return `\n[Vision Proxy — unavailable, ${count} image(s) (${types}) could not be analyzed. SILICONFLOW_API_KEY may be missing.]\n`;
}
