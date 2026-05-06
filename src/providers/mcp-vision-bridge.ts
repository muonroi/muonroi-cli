/**
 * Vision Bridge — universal image intelligence layer for text-only models.
 *
 * This is NOT limited to Playwright. Any task involving images flows through here:
 * 1. MCP tool results containing images (Playwright, Figma, any MCP server)
 * 2. Proactive image analysis from file paths or URLs
 * 3. Follow-up questions about previously seen images
 * 4. Image comparison and diff detection
 *
 * Text-only models (DeepSeek, etc.) call the vision proxy PROACTIVELY —
 * they don't wait for images to appear, they request analysis when needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { needsVisionProxy } from "./vision-proxy.js";
import { loadKeyForProvider } from "./keychain.js";

const VISION_MODELS = [
  "Qwen/Qwen2.5-VL-32B-Instruct",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
] as const;
const SILICONFLOW_BASE = "https://api.siliconflow.com/v1";
const REQUEST_TIMEOUT_MS = 45_000;
const IMAGE_CACHE_MAX = 20;
const IMAGE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff", ".tif",
]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

// Text-only snapshot tools that don't need vision proxy
const TEXT_RESULT_TOOLS = new Set([
  "browser_snapshot",
  "take_snapshot",
  "computer_snapshot",
]);

// ---------------------------------------------------------------------------
// Image cache — stores images so text-only models can ask follow-up questions
// ---------------------------------------------------------------------------

interface CachedImage {
  id: string;
  base64: string;
  mediaType: string;
  source: string;
  label: string;
  description: string;
  timestamp: number;
}

const imageCache: CachedImage[] = [];
let cacheIdCounter = 0;

function addToCache(images: ExtractedImage[], description: string, label?: string): string[] {
  const ids: string[] = [];
  const now = Date.now();

  // Evict expired
  while (imageCache.length > 0 && now - imageCache[0].timestamp > IMAGE_CACHE_TTL_MS) {
    imageCache.shift();
  }

  for (const img of images) {
    const id = `img_${++cacheIdCounter}`;
    imageCache.push({
      id,
      base64: img.base64,
      mediaType: img.mediaType,
      source: img.source,
      label: label ?? img.source,
      description,
      timestamp: now,
    });
    ids.push(id);

    while (imageCache.length > IMAGE_CACHE_MAX) {
      imageCache.shift();
    }
  }

  return ids;
}

function getCachedImage(id: string): CachedImage | undefined {
  return imageCache.find((img) => img.id === id);
}

function getRecentImages(count = 1): CachedImage[] {
  const now = Date.now();
  return imageCache
    .filter((img) => now - img.timestamp < IMAGE_CACHE_TTL_MS)
    .slice(-count);
}

export function listCachedImages(): Array<{ id: string; source: string; label: string; age: string; hasDescription: boolean }> {
  const now = Date.now();
  return imageCache
    .filter((img) => now - img.timestamp < IMAGE_CACHE_TTL_MS)
    .map((img) => ({
      id: img.id,
      source: img.source,
      label: img.label,
      age: `${Math.round((now - img.timestamp) / 1000)}s ago`,
      hasDescription: img.description.length > 0,
    }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface McpVisionBridgeResult {
  output: unknown;
  proxied: boolean;
  description?: string;
  cachedImageIds?: string[];
}

/**
 * Intercept any tool result and proxy images for text-only models.
 * Works for ALL MCP tools, built-in tools, or any tool returning image data.
 */
export async function bridgeMcpToolResult(
  toolName: string,
  toolOutput: unknown,
  modelId: string,
  signal?: AbortSignal,
): Promise<McpVisionBridgeResult> {
  if (!needsVisionProxy(modelId)) {
    return { output: toolOutput, proxied: false };
  }

  const baseName = extractBaseName(toolName);

  // Text-based tools (a11y snapshots) — no proxy needed
  if (TEXT_RESULT_TOOLS.has(baseName)) {
    return { output: toolOutput, proxied: false };
  }

  // Scan output for embedded images
  const images = extractBase64Images(toolOutput);
  if (images.length === 0) {
    return { output: toolOutput, proxied: false };
  }

  // Detect context for better analysis prompt
  const context = detectImageContext(toolName, toolOutput);
  const description = await analyzeImages(images, context, signal);
  if (!description) {
    return {
      output: wrapWithFallback(toolOutput, images.length),
      proxied: false,
    };
  }

  const cachedIds = addToCache(
    images.map((img) => ({ ...img, source: baseName || toolName })),
    description,
    `${baseName} result`,
  );

  const cleanOutput = stripBase64FromOutput(toolOutput);
  const cacheHint = `\n[Cached as ${cachedIds.join(", ")} — use ask_vision_proxy for follow-up questions]`;
  const enhanced = typeof cleanOutput === "string"
    ? `${cleanOutput}\n\n${description}${cacheHint}`
    : { ...(cleanOutput as Record<string, unknown>), _visionDescription: description, _cachedImageIds: cachedIds };

  return { output: enhanced, proxied: true, description, cachedImageIds: cachedIds };
}

/**
 * Proactively analyze an image from a file path, URL, or raw base64.
 * Text-only models call this when they KNOW an image exists and need to understand it.
 */
export async function analyzeImageFromSource(
  source: string,
  question?: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  let images: ExtractedImage[];

  // Try as file path
  const absPath = cwd ? resolve(cwd, source) : source;
  if (existsSync(absPath) && isImageFile(absPath)) {
    try {
      const buf = readFileSync(absPath);
      const ext = extname(absPath).toLowerCase();
      images = [{
        base64: buf.toString("base64"),
        mediaType: MIME_MAP[ext] ?? "image/png",
        source: absPath,
      }];
    } catch (err) {
      return `Failed to read image file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Try as base64
  else if (isLikelyBase64Image(source)) {
    images = [{
      base64: source,
      mediaType: guessMediaType(source),
      source: "inline-base64",
    }];
  }
  // Try as data URI
  else if (source.startsWith("data:image/")) {
    const match = source.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (match) {
      images = [{ base64: match[2], mediaType: match[1], source: "data-uri" }];
    } else {
      return "Invalid data URI format.";
    }
  }
  else {
    return `Cannot resolve image source: "${source}". Provide a valid file path, data URI, or base64 string.`;
  }

  const context: ImageContext = question
    ? { type: "user-query", hint: question }
    : { type: "generic" };

  const prompt = question
    ? buildFollowUpPrompt(question, images.length)
    : undefined;

  const description = await analyzeImages(images, context, signal, prompt);
  if (!description) {
    return "Vision proxy could not analyze the image. Check SILICONFLOW_API_KEY configuration.";
  }

  const cachedIds = addToCache(images, description, source);
  return `${description}\n[Cached as ${cachedIds.join(", ")} — use ask_vision_proxy for follow-up questions]`;
}

/**
 * Ask a follow-up question about a previously cached image,
 * or provide a file path to analyze a new image with a specific question.
 */
export async function askVisionProxy(
  question: string,
  imageIdOrPath?: string,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  // If it looks like a file path, analyze it directly
  if (imageIdOrPath && !imageIdOrPath.startsWith("img_")) {
    return analyzeImageFromSource(imageIdOrPath, question, cwd, signal);
  }

  const targets = imageIdOrPath
    ? [getCachedImage(imageIdOrPath)].filter(Boolean) as CachedImage[]
    : getRecentImages(1);

  if (targets.length === 0) {
    const cached = listCachedImages();
    if (cached.length === 0) {
      return [
        "No images in cache. You can:",
        "- Use analyze_image with a file path to analyze an image from disk",
        "- Take a screenshot with browser_take_screenshot (if using Playwright)",
        "- Paste an image from clipboard",
        "Then ask your question.",
      ].join("\n");
    }
    return `No matching image. Available:\n${cached.map((c) => `- ${c.id}: ${c.label} (${c.age})`).join("\n")}\n\nSpecify image_id, or provide a file_path to analyze a new image.`;
  }

  let apiKey: string;
  try {
    apiKey = await loadKeyForProvider("siliconflow");
  } catch {
    return "Vision proxy unavailable — SILICONFLOW_API_KEY not configured.";
  }

  const visionContent: Array<Record<string, unknown>> = [];
  visionContent.push({
    type: "text",
    text: buildFollowUpPrompt(question, targets.length),
  });

  for (const img of targets) {
    visionContent.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType};base64,${img.base64}`,
        detail: "high",
      },
    });
  }

  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, visionContent, apiKey, signal);
      if (result) {
        return `[Vision Proxy Answer — via ${model}]\n${result}\n[/Vision Proxy Answer]`;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  return "Vision proxy failed. Try again or describe what you need help with.";
}

/**
 * System prompt guidance for text-only models — UNIVERSAL, not Playwright-specific.
 */
export function getVisionGuidanceForTextOnly(modelId: string): string {
  if (!needsVisionProxy(modelId)) return "";

  return `
VISION PROXY (text-only model):
You cannot see images directly. You have vision proxy tools to work with ANY image:

TOOLS:
- analyze_image: Proactively analyze an image from a file path, URL, or base64. Use this FIRST when you encounter or need to work with an image.
- ask_vision_proxy: Ask a specific follow-up question about any cached image (or provide a file path for a new image).
- list_vision_cache: See all cached images available for querying.

WHEN TO USE (be PROACTIVE, not passive):
- User mentions an image file → analyze_image immediately
- User pastes or references a screenshot → it's auto-analyzed, use ask_vision_proxy for details
- Working with UI/web pages → prefer browser_snapshot (text-based), use screenshot + ask_vision_proxy when visual details matter
- Reviewing design mockups, diagrams, charts → analyze_image the file
- Debugging visual issues (CSS, layout, colors) → take screenshot, then ask_vision_proxy specific questions
- Comparing before/after → analyze both images, ask about differences
- Reading text from images (OCR) → analyze_image with a question like "transcribe all text"
- Any file with image extension (.png, .jpg, .gif, .webp, .svg, etc.) → analyze_image

WORKFLOW:
1. Encounter image → analyze_image (or it's auto-analyzed from tool results)
2. Need more detail → ask_vision_proxy with specific question
3. Need to verify changes → take new screenshot/analyze new image → compare

Images are cached (up to ${IMAGE_CACHE_MAX}, ${IMAGE_CACHE_TTL_MS / 60000}min TTL). You can reference them by ID for follow-ups.

IMPORTANT: Do NOT guess what an image contains. Always use the proxy to get accurate information.
`;
}

// Keep backward compat export
export const getPlaywrightGuidanceForTextOnly = getVisionGuidanceForTextOnly;

// ---------------------------------------------------------------------------
// Image context detection — tailors analysis prompts to the image type
// ---------------------------------------------------------------------------

interface ImageContext {
  type: "web-screenshot" | "code" | "diagram" | "design" | "terminal" | "generic" | "user-query";
  hint?: string;
}

function detectImageContext(toolName: string, _output: unknown): ImageContext {
  const base = extractBaseName(toolName);

  if (base.includes("screenshot") || base.includes("capture")) {
    if (toolName.includes("playwright") || toolName.includes("browser") || toolName.includes("devtools")) {
      return { type: "web-screenshot" };
    }
    if (toolName.includes("computer") || toolName.includes("desktop")) {
      return { type: "generic", hint: "desktop screenshot" };
    }
    return { type: "web-screenshot" };
  }

  if (toolName.includes("figma") || toolName.includes("design")) {
    return { type: "design" };
  }

  if (base.includes("generate_image") || base.includes("render")) {
    return { type: "design" };
  }

  return { type: "generic" };
}

// ---------------------------------------------------------------------------
// Core analysis engine
// ---------------------------------------------------------------------------

async function analyzeImages(
  images: ExtractedImage[],
  context: ImageContext,
  signal?: AbortSignal,
  customPrompt?: string,
): Promise<string | null> {
  let apiKey: string;
  try {
    apiKey = await loadKeyForProvider("siliconflow");
  } catch {
    return null;
  }

  const visionContent: Array<Record<string, unknown>> = [];
  visionContent.push({
    type: "text",
    text: customPrompt ?? buildContextualPrompt(images.length, context),
  });

  for (const img of images) {
    visionContent.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType};base64,${img.base64}`,
        detail: "high",
      },
    });
  }

  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, visionContent, apiKey, signal);
      if (result) {
        return formatBridgeResult(result, images.length, model, context.type);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  return null;
}

function buildContextualPrompt(imageCount: number, context: ImageContext): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";

  const base = `Analyze ${plural} for a software developer using a CLI tool. `;

  switch (context.type) {
    case "web-screenshot":
      return base + [
        "This is a web browser screenshot. Focus on:",
        "",
        "## Page Structure",
        "- Page title, URL if visible",
        "- Main layout sections (header, nav, sidebar, content, footer)",
        "- Current page state (loading, loaded, error, modal open)",
        "",
        "## Interactive Elements (CRITICAL for automation)",
        "- All buttons: label, state (enabled/disabled), approximate position",
        "- All form inputs: label, type, current value, placeholder",
        "- All links: text, destination if visible",
        "- Dropdowns, checkboxes, radio buttons, toggles",
        "- Any clickable or interactive element",
        "",
        "## Text Content",
        "- All visible text, organized by section",
        "- Error messages or alerts (HIGHLIGHT prominently)",
        "- Form validation messages, toast notifications",
        "",
        "## Visual State",
        "- Active/focused element, disabled elements",
        "- Loading indicators, progress bars",
        "- Scroll position (more content below/right?)",
        "- Overlays, modals, popups blocking interaction",
        "",
        "## Targeting Hints",
        "- Suggest text patterns or roles for key elements",
        "- Note elements that need scrolling to reach",
        "",
        "Be precise. Use markdown. For each interactive element, describe how to target it.",
      ].join("\n");

    case "design":
      return base + [
        "This is a design mockup or generated image. Focus on:",
        "- Overall layout and composition",
        "- Color palette and typography",
        "- UI components and their arrangement",
        "- Spacing, alignment, visual hierarchy",
        "- Any text content (transcribe exactly)",
        "- Design patterns and style choices",
        "Be specific about visual details — the developer cannot see this image.",
      ].join("\n");

    case "code":
      return base + [
        "This image contains code or a code editor. Focus on:",
        "- Transcribe ALL visible code EXACTLY as shown",
        "- Note the programming language",
        "- Highlight any syntax errors, warnings, or linting markers",
        "- Describe any error indicators (red underlines, gutter icons)",
        "- Note file name/path if visible",
        "- Note line numbers if visible",
      ].join("\n");

    case "terminal":
      return base + [
        "This is a terminal or console output. Focus on:",
        "- Transcribe ALL visible text EXACTLY",
        "- Highlight error messages, warnings, stack traces",
        "- Note the command that was run if visible",
        "- Note exit codes, status indicators",
        "- Describe the overall state (success, failure, in-progress)",
      ].join("\n");

    case "diagram":
      return base + [
        "This is a technical diagram. Focus on:",
        "- Diagram type (flowchart, sequence, architecture, ER, etc.)",
        "- All nodes/boxes and their labels",
        "- All connections/arrows and their labels/directions",
        "- The flow of data or control",
        "- Any groupings or boundaries",
        "- Legend or annotations if present",
        "Describe the diagram as structured text that can be recreated.",
      ].join("\n");

    default: {
      const hint = context.hint ? `\nContext: ${context.hint}` : "";
      return base + [
        "Provide a comprehensive analysis:" + hint,
        "- Describe what the image shows overall",
        "- Transcribe any visible text exactly",
        "- Note colors, layout, and important visual details",
        "- If it's a UI: list interactive elements and how to target them",
        "- If it contains code: transcribe it exactly",
        "- If it's a diagram: describe the structure and connections",
        "- If it's a photo/graphic: describe relevant details for the developer's context",
        "Be precise — the developer cannot see this image and relies entirely on your description.",
      ].join("\n");
    }
  }
}

function buildFollowUpPrompt(question: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `A software developer is asking about ${plural}. They cannot see it (text-only model).`,
    "",
    `Question: ${question}`,
    "",
    "Answer the specific question directly. Be precise about visual details.",
    "If the question is about an element, describe how to target it (text, role, selector).",
    "For text in the image, transcribe exactly. If you can't answer, say so clearly.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBaseName(toolName: string): string {
  // Strip any MCP prefix like mcp_playwright__, mcp_figma__, etc.
  return toolName.replace(/^mcp_[a-zA-Z0-9_-]+__/, "");
}

export function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

interface ExtractedImage {
  base64: string;
  mediaType: string;
  source: string;
}

function extractBase64Images(output: unknown): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const str = typeof output === "string" ? output : JSON.stringify(output ?? "");

  // Data URIs
  const dataUriRegex = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]{100,})/g;
  let match;
  while ((match = dataUriRegex.exec(str)) !== null) {
    images.push({ base64: match[2], mediaType: match[1], source: "data-uri" });
  }

  // Raw base64 in object fields
  if (images.length === 0 && typeof output === "object" && output !== null) {
    walkObject(output, (key, value) => {
      if (typeof value === "string" && value.length > 500 && isLikelyBase64Image(value)) {
        images.push({ base64: value, mediaType: guessMediaType(value), source: key });
      }
    });
  }

  return images;
}

function walkObject(obj: unknown, visitor: (key: string, value: unknown) => void, prefix = ""): void {
  if (obj === null || obj === undefined || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    visitor(path, value);
    if (typeof value === "object" && value !== null) walkObject(value, visitor, path);
  }
}

function isLikelyBase64Image(str: string): boolean {
  if (str.startsWith("iVBORw0KGgo")) return true; // PNG
  if (str.startsWith("/9j/")) return true; // JPEG
  if (str.startsWith("UklGR")) return true; // WebP
  if (str.startsWith("R0lGODlh") || str.startsWith("R0lGODdh")) return true; // GIF
  return /^[A-Za-z0-9+/]{500,}={0,2}$/.test(str.slice(0, 600));
}

function guessMediaType(base64: string): string {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGODlh") || base64.startsWith("R0lGODdh")) return "image/gif";
  return "image/png";
}

function stripBase64FromOutput(output: unknown): unknown {
  if (typeof output === "string") {
    let cleaned = output.replace(
      /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{100,}/g,
      "[image data removed — see vision description below]",
    );
    cleaned = cleaned.replace(
      /(?:^|")\s*[A-Za-z0-9+/]{500,}={0,2}\s*(?:"|$)/g,
      '"[image data removed — see vision description below]"',
    );
    return cleaned;
  }
  if (typeof output === "object" && output !== null) {
    const clone = JSON.parse(JSON.stringify(output));
    walkAndStrip(clone);
    return clone;
  }
  return output;
}

function walkAndStrip(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.length > 500 && isLikelyBase64Image(value)) {
      obj[key] = "[image data removed — see vision description below]";
    } else if (typeof value === "object" && value !== null) {
      walkAndStrip(value as Record<string, unknown>);
    }
  }
}

function wrapWithFallback(output: unknown, imageCount: number): unknown {
  const notice = `\n[Vision Bridge — ${imageCount} image(s) could not be analyzed. Use analyze_image or ask_vision_proxy with a file path to retry.]\n`;
  if (typeof output === "string") return `${output}\n${notice}`;
  return { ...(output as Record<string, unknown>), _visionNotice: notice };
}

async function callVisionModel(
  model: string,
  content: Array<Record<string, unknown>>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
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
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 3072,
      temperature: 0.1,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

function formatBridgeResult(description: string, imageCount: number, model: string, contextType: string): string {
  const header = imageCount > 1
    ? `[Vision Bridge — ${imageCount} images analyzed (${contextType}) via ${model}]`
    : `[Vision Bridge — image analyzed (${contextType}) via ${model}]`;
  return `\n${header}\n${description}\n[/Vision Bridge]\n`;
}
