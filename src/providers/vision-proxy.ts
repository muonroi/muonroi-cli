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
import { UI_LAYOUT_SCHEMA_HINT } from "./mcp-vision-bridge.js";

const DESIGN_INTENT_PATTERNS = [
  /\bredesign\b/i,
  /\bdesign\s*(system|token|spec|review)?\b/i,
  /\bui\s*(layout|kit|spec|design)\b/i,
  /\blayout\b/i,
  /\bmockup\b/i,
  /\bwireframe\b/i,
  /\bfigma\b/i,
  /\bcomponent\s*(library|spec|map)\b/i,
  /thiết\s*kế|giao\s*diện|bố\s*cục|redesign/i,
];

function looksLikeDesignIntent(text: string): boolean {
  if (!text) return false;
  return DESIGN_INTENT_PATTERNS.some((re) => re.test(text));
}

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

    const userText = textParts.map((t) => t.text).join("\n");
    const designIntent = looksLikeDesignIntent(userText);

    const svgFast = trySvgFastPath(imageParts, designIntent);
    if (svgFast) {
      processed.push({
        ...msg,
        content: [...textParts, { type: "text" as const, text: svgFast }],
      });
      continue;
    }

    const descriptions = await describeImages(imageParts, textParts, signal, designIntent);

    const newContent = [...textParts, { type: "text" as const, text: descriptions }];
    processed.push({ ...msg, content: newContent });
  }

  return { messages: processed, proxied: totalImages > 0, imageCount: totalImages };
}

async function describeImages(
  images: ImagePart[],
  contextTexts: TextPart[],
  signal?: AbortSignal,
  designIntent = false,
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
    text: designIntent
      ? buildDesignPrompt(userContext, images.length)
      : buildAnalysisPrompt(userContext, images.length),
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

  const responseFormat = designIntent ? { type: "json_object" as const } : undefined;

  const failureReasons: string[] = [];
  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, visionContent, apiKey, signal, responseFormat);
      if (result.ok) return formatVisionResult(result.text, images.length, model, designIntent);
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

function trySvgFastPath(images: ImagePart[], designIntent: boolean): string | null {
  if (images.length === 0) return null;
  if (!images.every((img) => img.mediaType === "image/svg+xml")) return null;

  const decoded = images
    .map((img, idx) => {
      let svg: string;
      try {
        svg = Buffer.from(img.image, "base64").toString("utf8");
      } catch {
        return `<!-- svg ${idx + 1}: decode failed -->`;
      }
      return svg.length > 32_000 ? `${svg.slice(0, 32_000)}\n<!-- truncated -->` : svg;
    })
    .join("\n\n");

  const header = `[Vision Proxy — ${images.length} SVG source(s) passed through (fast-path, no vision call)]`;
  const guidance = designIntent
    ? `\nThe raw SVG below IS the layout contract. Map nodes to:\n${UI_LAYOUT_SCHEMA_HINT}\n`
    : "\nThe raw SVG below is vector text — read element attributes (x, y, width, fill, text content) directly.\n";
  return `\n${header}${guidance}\n\`\`\`svg\n${decoded}\n\`\`\`\n[/Vision Proxy]\n`;
}

type VisionCallResult = { ok: true; text: string } | { ok: false; reason: string };

async function callVisionModel(
  model: string,
  content: Array<Record<string, unknown>>,
  apiKey: string,
  signal?: AbortSignal,
  responseFormat?: { type: "json_object" },
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
    const errText = await res.text().catch(() => "unknown error");
    return { ok: false, reason: `HTTP ${res.status} ${errText.slice(0, 200)}` };
  }

  const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return { ok: false, reason: "empty response body" };
  return { ok: true, text };
}

function buildAnalysisPrompt(userContext: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `You are a vision model. Analyze ${plural} for a software developer working in a coding CLI tool.`,
    "Use your full vision capability — do NOT refuse on the basis of being text-only.",
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

function formatVisionResult(description: string, imageCount: number, model?: string, designIntent = false): string {
  const usedModel = model ?? VISION_MODELS[0];
  const tag = designIntent ? "design contract via" : "analyzed via";
  const single = designIntent ? "design contract via" : "analyzed via";
  const header =
    imageCount > 1
      ? `[Vision Proxy — ${imageCount} images ${tag} ${usedModel}]`
      : `[Vision Proxy — image ${single} ${usedModel}]`;
  return `\n${header}\n${description}\n[/Vision Proxy]\n`;
}

function buildDesignPrompt(userContext: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `Analyze ${plural} as a UI/UX design contract for a software developer who CANNOT see the image.`,
    "Output will be consumed by another AI agent to recreate or redesign this UI, so precision matters more than prose.",
    "",
    "Return ONLY a single JSON object matching this exact shape (no markdown, no commentary, no code fences):",
    UI_LAYOUT_SCHEMA_HINT,
    "",
    "Extraction rules:",
    "- bbox: pixel coordinates relative to the visible image (origin top-left). Estimate when unsure but never omit.",
    "- Colors: 6-digit lowercase hex (#rrggbb). Sample dominant pixel.",
    "- Typography sizePx: estimate from cap-height, round to nearest 2.",
    "- spacingScalePx / radiusScalePx: distinct observed values, sorted ascending.",
    "- components[]: every visible interactive or content element. Stable IDs like 'btn_signup'.",
    "- children[]: component IDs nested inside this component.",
    "- hierarchy[]: visual reading order of headings — level 1 hero, 2 section, 3 sub.",
    "- text: EXACT visible string. null only when no text (icon-only).",
    "- notes[]: things schema cannot capture — gradients, illustrations, motion.",
    "",
    "If a field is genuinely not determinable, use null. Never invent values.",
    userContext ? `\nDeveloper's context: "${userContext}"` : "",
  ].join("\n");
}

function buildFallbackDescription(images: ImagePart[], reasons: string[] = []): string {
  const count = images.length;
  const types = [...new Set(images.map((i) => i.mediaType))].join(", ");
  const detail =
    reasons.length > 0
      ? `Reason(s): ${reasons.join(" | ")}`
      : "Reason: unknown — check SILICONFLOW_API_KEY and model availability.";
  return `\n[Vision Proxy — unavailable, ${count} image(s) (${types}) could not be analyzed. ${detail}]\n`;
}
