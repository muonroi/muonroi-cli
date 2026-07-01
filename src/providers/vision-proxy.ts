/**
 * Vision proxy layer for text-only models (e.g. DeepSeek V4).
 *
 * Image parts in messages are sent to the catalog-configured vision backend
 * (default: Z.ai glm-4.6v-flash) and replaced with native-sight observations
 * so the primary model reasons as if it saw the image directly.
 */

import type { ModelMessage } from "ai";
import { getModelInfo } from "../models/registry.js";
import { UI_LAYOUT_SCHEMA_HINT } from "./mcp-vision-bridge.js";
import {
  callVisionBackend,
  collectVisionUnavailableReasons,
  findNativeVisionFallback,
  formatNativeVisionObservation,
  formatNativeVisionUnavailable,
  isVisionBackendAvailable,
  looksLikeOcrIntent,
  type NativeVisionFallback,
  resolveAvailableVisionChain,
  type VisionTaskKind,
  wrapAnalyzerInstructions,
} from "./vision-backend.js";

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

interface ImagePart {
  type: "image";
  image: string;
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

export function needsVisionProxy(modelId: string): boolean {
  const info = getModelInfo(modelId);
  return info?.supportsVision === false;
}

export type ImageHandlingPlan =
  | { strategy: "proxy" }
  | { strategy: "native_model"; fallback: NativeVisionFallback }
  | { strategy: "unavailable"; notice: string };

/**
 * Decide how to handle images when the active model is text-only:
 * proxy backend, switch to a native vision model, or surface unavailable.
 */
export async function planImageHandlingForTextOnlyModel(opts: {
  primaryModelId: string;
  imageCount: number;
  kind?: VisionTaskKind;
}): Promise<ImageHandlingPlan> {
  if (!needsVisionProxy(opts.primaryModelId)) {
    return { strategy: "proxy" };
  }

  const kind = opts.kind ?? "default";
  if (await isVisionBackendAvailable(kind)) {
    return { strategy: "proxy" };
  }

  const fallback = await findNativeVisionFallback({ excludeModelId: opts.primaryModelId });
  if (fallback) {
    return { strategy: "native_model", fallback };
  }

  const reasons = await collectVisionUnavailableReasons(kind);
  return {
    strategy: "unavailable",
    notice: formatNativeVisionUnavailable(opts.imageCount, reasons),
  };
}

/** True when proxy backend or a native vision model can handle images for this text-only model. */
export async function canHandleImagesForTextOnlyModel(modelId: string): Promise<boolean> {
  if (!needsVisionProxy(modelId)) return true;
  if (await isVisionBackendAvailable()) return true;
  return (await findNativeVisionFallback({ excludeModelId: modelId })) !== null;
}

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
    const ocrIntent = looksLikeOcrIntent(userText);

    const svgFast = trySvgFastPath(imageParts, designIntent);
    if (svgFast) {
      processed.push({
        ...msg,
        content: [...textParts, { type: "text" as const, text: svgFast }],
      });
      continue;
    }

    const kind: VisionTaskKind = designIntent ? "design" : ocrIntent ? "ocr" : "default";
    const descriptions = await describeImages(imageParts, textParts, signal, kind);

    const newContent = [...textParts, { type: "text" as const, text: descriptions }];
    processed.push({ ...msg, content: newContent });
  }

  return { messages: processed, proxied: totalImages > 0, imageCount: totalImages };
}

async function describeImages(
  images: ImagePart[],
  contextTexts: TextPart[],
  signal?: AbortSignal,
  kind: VisionTaskKind = "default",
): Promise<string> {
  const userContext = contextTexts.map((t) => t.text).join("\n");
  const designIntent = kind === "design";

  const visionContent: Array<Record<string, unknown>> = [];
  visionContent.push({
    type: "text",
    text: wrapAnalyzerInstructions(
      designIntent
        ? buildDesignPrompt(userContext, images.length)
        : buildAnalysisPrompt(userContext, images.length, kind === "ocr"),
      kind,
    ),
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
  const chain = await resolveAvailableVisionChain(kind);
  const result = await callVisionBackend(chain, visionContent, signal, responseFormat);

  if (result.ok) {
    return formatNativeVisionObservation(result.text, { imageCount: images.length });
  }

  return formatNativeVisionUnavailable(images.length, [result.reason]);
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

  const observation = designIntent
    ? `I see ${images.length} SVG source(s). The vector markup below is exact — use element attributes (x, y, width, fill, text) directly.\n\nMap to layout schema:\n${UI_LAYOUT_SCHEMA_HINT}\n\n\`\`\`svg\n${decoded}\n\`\`\``
    : `I see ${images.length} SVG source(s). Vector markup (read attributes directly):\n\n\`\`\`svg\n${decoded}\n\`\`\``;

  return formatNativeVisionObservation(observation, { imageCount: images.length });
}

function buildAnalysisPrompt(userContext: string, imageCount: number, ocrFocus: boolean): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  const ocrBlock = ocrFocus
    ? [
        "OCR focus: transcribe ALL visible text exactly (preserve line breaks, labels, error codes).",
        "Note any text that is blurry or partially cut off.",
        "",
      ]
    : [];
  return [
    `Analyze ${plural} for a software developer working in a coding CLI.`,
    ...ocrBlock,
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

function buildDesignPrompt(userContext: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `Analyze ${plural} as a UI/UX design contract for a software developer.`,
    "Return ONLY a single JSON object matching this exact shape (no markdown, no commentary):",
    UI_LAYOUT_SCHEMA_HINT,
    "",
    "Extraction rules:",
    "- bbox: pixel coordinates relative to the visible image (origin top-left).",
    "- Colors: 6-digit lowercase hex (#rrggbb).",
    "- components[]: every visible interactive or content element.",
    "- text: EXACT visible string. null only when no text (icon-only).",
    userContext ? `\nDeveloper's context: "${userContext}"` : "",
  ].join("\n");
}
