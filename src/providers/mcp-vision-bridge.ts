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
import { extname, resolve } from "node:path";
import { apiBaseFor } from "./endpoints.js";
import { loadKeyForProvider } from "./keychain.js";
import { needsVisionProxy } from "./vision-proxy.js";

const VISION_MODELS = [
  "Qwen/Qwen3-VL-8B-Instruct",
  "Qwen/Qwen3-VL-30B-A3B-Instruct",
  "Qwen/Qwen3-VL-32B-Instruct",
] as const;
const SILICONFLOW_BASE = apiBaseFor("siliconflow");
const REQUEST_TIMEOUT_MS = 90_000;
const IMAGE_CACHE_MAX = 20;
const IMAGE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Hard cap on a single tool-result output before persisting to history.
 *
 * Picked from observed pain: a `directory_tree` of node_modules (2.6MB) plus a
 * `bash` recursive find (1.3MB) in the same session pushed the next turn past
 * the 1M-token window. 200KB ≈ 50K tokens — large enough to carry useful
 * structured output (test results, schema dumps, big logs) but small enough
 * that ten of them in history won't overflow even a 512K-token model.
 *
 * Tunable via env so power users can widen for offline analysis sessions.
 */
const TOOL_OUTPUT_MAX_BYTES = (() => {
  const raw = process.env.MUONROI_TOOL_OUTPUT_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 1024 ? parsed : 200_000;
})();
const TOOL_OUTPUT_HEAD_BYTES = Math.floor(TOOL_OUTPUT_MAX_BYTES * 0.7);
const TOOL_OUTPUT_TAIL_BYTES = Math.floor(TOOL_OUTPUT_MAX_BYTES * 0.2);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff", ".tif"]);

/**
 * Structured layout schema returned for `design` context.
 * Downstream agents consume this JSON directly instead of re-parsing markdown.
 * Kept embedded in the prompt (not strict JSON-schema mode) for cross-provider portability.
 */
export const UI_LAYOUT_SCHEMA_HINT = `{
  "viewport": { "width": number, "height": number, "deviceClass": "mobile" | "tablet" | "desktop" },
  "tokens": {
    "colors": [{ "name": string, "hex": string, "role": "primary" | "secondary" | "accent" | "bg" | "fg" | "border" | "muted" }],
    "typography": [{ "role": "heading" | "body" | "caption" | "label", "fontFamily": string, "sizePx": number, "weight": number }],
    "spacingScalePx": number[],
    "radiusScalePx": number[]
  },
  "layout": { "type": "stack" | "grid" | "flex" | "absolute", "direction": "row" | "column", "gapPx": number, "columns": number | null },
  "components": [{
    "id": string,
    "role": "button" | "input" | "card" | "nav" | "header" | "footer" | "image" | "icon" | "text" | "list" | "modal" | "tabs" | "table" | "chart" | "container" | "other",
    "label": string,
    "text": string | null,
    "bbox": { "x": number, "y": number, "w": number, "h": number },
    "style": { "bgHex": string | null, "fgHex": string | null, "borderHex": string | null, "radiusPx": number | null, "shadow": string | null },
    "state": "default" | "hover" | "active" | "disabled" | "focus" | "error",
    "children": string[]
  }],
  "hierarchy": [{ "level": 1 | 2 | 3, "text": string, "componentId": string }],
  "notes": string[]
}`;

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
const TEXT_RESULT_TOOLS = new Set(["browser_snapshot", "take_snapshot", "computer_snapshot"]);

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
  return imageCache.filter((img) => now - img.timestamp < IMAGE_CACHE_TTL_MS).slice(-count);
}

export function listCachedImages(): Array<{
  id: string;
  source: string;
  label: string;
  age: string;
  hasDescription: boolean;
}> {
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
 * Vision descriptions keyed by toolCallId. The streaming chunk handler bridges
 * `tr.output` for the live UI, but the AI SDK's `response.messages` contains
 * its own tool-result entries with the raw image bytes. Persisting those would
 * leave the next turn with `[image data removed]` and NO description, since
 * scrubImagePayloadsInMessages only strips bytes — it doesn't know what the
 * vision model said. We stash the description here at bridge-time so the scrub
 * pass can re-inject it.
 *
 * Trimmed opportunistically (LRU-ish) to keep this from leaking memory across
 * a long-running session.
 */
const bridgedDescriptions = new Map<string, string>();
const BRIDGED_DESCRIPTIONS_MAX = 64;

function recordBridgedDescription(toolCallId: string | undefined, description: string): void {
  if (!toolCallId) return;
  if (bridgedDescriptions.size >= BRIDGED_DESCRIPTIONS_MAX) {
    const firstKey = bridgedDescriptions.keys().next().value;
    if (firstKey) bridgedDescriptions.delete(firstKey);
  }
  bridgedDescriptions.set(toolCallId, description);
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
  toolCallId?: string,
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
    // Even when the vision proxy fails (no API key / network error), we MUST
    // still strip the base64 payload from the tool output. Otherwise a single
    // Playwright screenshot (~1.5MB of base64) lands in conversation history
    // and blows up the next turn's context window — the failure surfaces as
    // "maximum context length is 1048576 tokens" at the provider call.
    const stripped = stripBase64FromOutput(toolOutput);
    return {
      output: wrapWithFallback(stripped, images.length),
      proxied: true,
    };
  }

  const cachedIds = addToCache(
    images.map((img) => ({ ...img, source: baseName || toolName })),
    description,
    `${baseName} result`,
  );

  const cleanOutput = stripBase64FromOutput(toolOutput);
  const cacheHint = `\n[Cached as ${cachedIds.join(", ")} — use ask_vision_proxy for follow-up questions]`;
  const fullDescription = `${description}${cacheHint}`;
  const enhanced =
    typeof cleanOutput === "string"
      ? `${cleanOutput}\n\n${fullDescription}`
      : { ...(cleanOutput as Record<string, unknown>), _visionDescription: description, _cachedImageIds: cachedIds };

  recordBridgedDescription(toolCallId, fullDescription);
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
      images = [
        {
          base64: buf.toString("base64"),
          mediaType: MIME_MAP[ext] ?? "image/png",
          source: absPath,
        },
      ];
    } catch (err) {
      return `Failed to read image file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Try as base64
  else if (isLikelyBase64Image(source)) {
    images = [
      {
        base64: source,
        mediaType: guessMediaType(source),
        source: "inline-base64",
      },
    ];
  }
  // Try as data URI
  else if (source.startsWith("data:image/")) {
    const match = source.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (match) {
      images = [{ base64: match[2], mediaType: match[1], source: "data-uri" }];
    } else {
      return "Invalid data URI format.";
    }
  } else {
    return `Cannot resolve image source: "${source}". Provide a valid file path, data URI, or base64 string.`;
  }

  const context: ImageContext = question ? { type: "user-query", hint: question } : { type: "generic" };

  const prompt = question ? buildFollowUpPrompt(question, images.length) : undefined;

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
    ? ([getCachedImage(imageIdOrPath)].filter(Boolean) as CachedImage[])
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
  // Fast-path: SVG inputs are vector text. Skip the vision model entirely —
  // pass the source straight through wrapped in the layout contract envelope.
  // Saves the vision call cost AND preserves exact coordinates/colors that a
  // raster vision pass would only approximate.
  const svgFast = trySvgFastPath(images, context);
  if (svgFast) return svgFast;

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

  // Force JSON output for the design contract. Markdown narrative is fine for
  // debug-style contexts (terminal, code) where the human reads the result,
  // but design output is consumed machine-to-machine.
  const responseFormat = context.type === "design" ? { type: "json_object" as const } : undefined;

  for (const model of VISION_MODELS) {
    try {
      const result = await callVisionModel(model, visionContent, apiKey, signal, responseFormat);
      if (result) {
        return formatBridgeResult(result, images.length, model, context.type);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  return null;
}

function trySvgFastPath(images: ExtractedImage[], context: ImageContext): string | null {
  if (images.length === 0) return null;
  const allSvg = images.every((img) => img.mediaType === "image/svg+xml");
  if (!allSvg) return null;

  const decoded = images
    .map((img, idx) => {
      let svg: string;
      try {
        svg = Buffer.from(img.base64, "base64").toString("utf8");
      } catch {
        return `<!-- svg ${idx + 1}: decode failed -->`;
      }
      return svg.length > 32_000 ? `${svg.slice(0, 32_000)}\n<!-- truncated -->` : svg;
    })
    .join("\n\n");

  const header = `[Vision Bridge — ${images.length} SVG source(s) passed through (${context.type}, fast-path, no vision call)]`;
  const guidance =
    context.type === "design"
      ? `\nThe raw SVG below IS the layout contract. Coordinates and colors are exact. Map <rect>/<text>/<g> nodes to the schema:\n${UI_LAYOUT_SCHEMA_HINT}\n`
      : "\nThe raw SVG below is vector text — read element attributes (x, y, width, fill, text content) directly.\n";
  return `\n${header}${guidance}\n\`\`\`svg\n${decoded}\n\`\`\`\n[/Vision Bridge]\n`;
}

function buildContextualPrompt(imageCount: number, context: ImageContext): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";

  const base = `Analyze ${plural} for a software developer using a CLI tool. `;

  switch (context.type) {
    case "web-screenshot":
      return (
        base +
        [
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
        ].join("\n")
      );

    case "design":
      return [
        `Analyze ${plural} as a UI/UX design contract for a software developer who CANNOT see the image.`,
        "The output will be consumed by another AI agent to recreate or redesign this UI, so precision matters more than prose.",
        "",
        "Return ONLY a single JSON object matching this exact shape (no markdown, no commentary, no code fences):",
        UI_LAYOUT_SCHEMA_HINT,
        "",
        "Extraction rules:",
        "- bbox: pixel coordinates relative to the visible image (origin top-left). Estimate when unsure but never omit.",
        "- Colors: use 6-digit lowercase hex (#rrggbb). Sample dominant pixel, do not guess by name.",
        "- Typography sizePx: estimate from cap-height in pixels. Round to nearest 2.",
        "- spacingScalePx / radiusScalePx: list the DISTINCT values you observed, sorted ascending.",
        "- components[]: every visible interactive or content element. Use stable IDs like 'btn_signup', 'input_email'.",
        "- children[]: array of component IDs nested inside this component (containers/cards/nav).",
        "- hierarchy[]: visual reading order of headings — level=1 for hero/page title, 2 for section, 3 for sub.",
        "- text: the EXACT visible string. null only when the component has no text (icon-only).",
        "- notes[]: short strings for things the schema cannot capture — gradients, illustrations, motion cues, brand mood.",
        "",
        "If a field is genuinely not determinable, use null. Never invent values to fill the schema.",
      ].join("\n");

    case "code":
      return (
        base +
        [
          "This image contains code or a code editor. Focus on:",
          "- Transcribe ALL visible code EXACTLY as shown",
          "- Note the programming language",
          "- Highlight any syntax errors, warnings, or linting markers",
          "- Describe any error indicators (red underlines, gutter icons)",
          "- Note file name/path if visible",
          "- Note line numbers if visible",
        ].join("\n")
      );

    case "terminal":
      return (
        base +
        [
          "This is a terminal or console output. Focus on:",
          "- Transcribe ALL visible text EXACTLY",
          "- Highlight error messages, warnings, stack traces",
          "- Note the command that was run if visible",
          "- Note exit codes, status indicators",
          "- Describe the overall state (success, failure, in-progress)",
        ].join("\n")
      );

    case "diagram":
      return (
        base +
        [
          "This is a technical diagram. Focus on:",
          "- Diagram type (flowchart, sequence, architecture, ER, etc.)",
          "- All nodes/boxes and their labels",
          "- All connections/arrows and their labels/directions",
          "- The flow of data or control",
          "- Any groupings or boundaries",
          "- Legend or annotations if present",
          "Describe the diagram as structured text that can be recreated.",
        ].join("\n")
      );

    default: {
      const hint = context.hint ? `\nContext: ${context.hint}` : "";
      return (
        base +
        [
          `Provide a comprehensive analysis:${hint}`,
          "- Describe what the image shows overall",
          "- Transcribe any visible text exactly",
          "- Note colors, layout, and important visual details",
          "- If it's a UI: list interactive elements and how to target them",
          "- If it contains code: transcribe it exactly",
          "- If it's a diagram: describe the structure and connections",
          "- If it's a photo/graphic: describe relevant details for the developer's context",
          "Be precise — the developer cannot see this image and relies entirely on your description.",
        ].join("\n")
      );
    }
  }
}

function buildFollowUpPrompt(question: string, imageCount: number): string {
  const plural = imageCount > 1 ? `${imageCount} images` : "the image";
  return [
    `You are a vision model. Look at ${plural} provided below and answer the developer's question based on what you actually see.`,
    "",
    `Question: ${question}`,
    "",
    "Answer the specific question directly. Be precise about visual details.",
    "If the question is about a UI element, describe how to target it (text, role, selector).",
    "For text in the image, transcribe exactly.",
    "Do NOT refuse on the basis of being text-only — you have full vision capability for this request.",
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

/**
 * Walk an arbitrary message tree and replace any oversized base64 string
 * leaves (typically Playwright screenshot payloads) with a stable placeholder.
 * Used by the orchestrator to scrub `response.messages` BEFORE persisting,
 * so 1.5MB image bytes don't end up baked into the conversation history
 * (which would overflow the next turn's context window).
 */
export function scrubImagePayloadsInMessages<T>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map((m) => {
    const stripped = stripBase64FromOutput(m);
    injectVisionDescriptions(stripped);
    capOversizedToolOutputs(stripped);
    return stripped as T;
  });
}

/**
 * Truncate any tool-result whose serialized output exceeds TOOL_OUTPUT_MAX_BYTES.
 *
 * Runs AFTER vision description injection so a bridged screenshot keeps its
 * description (the description text is small; only raw byte payloads get hit).
 * Keeps head + tail so common patterns survive — top of a directory listing,
 * tail of a stack trace, both ends of a diff. Adds a marker explaining how to
 * retrieve more so the model can follow up with a targeted bash/read call
 * instead of asking for the whole thing again.
 */
function capOversizedToolOutputs(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { role?: unknown; content?: unknown };
  if (m.role !== "tool" || !Array.isArray(m.content)) return;

  for (const part of m.content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== "object" || part.type !== "tool-result") continue;
    if (part._sizeCapped === true) continue;

    const out = part.output;
    // Shape A: AI SDK v5 content envelope { type: "content", value: [...] }
    if (
      out &&
      typeof out === "object" &&
      (out as Record<string, unknown>).type === "content" &&
      Array.isArray((out as Record<string, unknown>).value)
    ) {
      const value = (out as { value: Array<Record<string, unknown>> }).value;
      for (const v of value) {
        if (v && typeof v === "object" && v.type === "text" && typeof v.text === "string") {
          v.text = capString(v.text, String(part.toolName ?? "tool"));
        }
      }
      part._sizeCapped = true;
      continue;
    }

    // Shape B: { type: "text", value: "..." } (some MCP shims)
    if (
      out &&
      typeof out === "object" &&
      (out as Record<string, unknown>).type === "text" &&
      typeof (out as Record<string, unknown>).value === "string"
    ) {
      (out as Record<string, unknown>).value = capString(
        (out as { value: string }).value,
        String(part.toolName ?? "tool"),
      );
      part._sizeCapped = true;
      continue;
    }

    // Shape C: plain string output
    if (typeof out === "string") {
      (part as Record<string, unknown>).output = capString(out, String(part.toolName ?? "tool"));
      part._sizeCapped = true;
      continue;
    }

    // Shape D: arbitrary object — measure JSON size, replace whole thing if too big.
    if (out && typeof out === "object") {
      let serialized: string;
      try {
        serialized = JSON.stringify(out);
      } catch {
        continue;
      }
      if (Buffer.byteLength(serialized, "utf8") > TOOL_OUTPUT_MAX_BYTES) {
        (part as Record<string, unknown>).output = capString(serialized, String(part.toolName ?? "tool"));
        part._sizeCapped = true;
      }
    }
  }
}

function capString(text: string, toolName: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TOOL_OUTPUT_MAX_BYTES) return text;

  const head = Buffer.from(text, "utf8").subarray(0, TOOL_OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = Buffer.from(text, "utf8")
    .subarray(bytes - TOOL_OUTPUT_TAIL_BYTES)
    .toString("utf8");
  const omitted = bytes - TOOL_OUTPUT_HEAD_BYTES - TOOL_OUTPUT_TAIL_BYTES;
  const marker =
    `\n\n[... ${omitted.toLocaleString()} bytes truncated by muonroi-cli ` +
    `(${toolName} output ${bytes.toLocaleString()}B > cap ${TOOL_OUTPUT_MAX_BYTES.toLocaleString()}B). ` +
    `Re-run with narrower scope or use bash head/tail/sed -n to retrieve specific ranges.]\n\n`;
  return `${head}${marker}${tail}`;
}

/**
 * For any tool-result part in this message whose toolCallId we bridged,
 * append the vision description as a text part. Without this, the AI SDK's
 * persisted message only carries the placeholder "[image data removed]" — the
 * primary model loses ALL visual context on subsequent turns and starts
 * calling ask_vision_proxy in confusion.
 *
 * Tolerant of unknown shapes; bails silently if the message isn't a tool message.
 */
function injectVisionDescriptions(msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as { role?: unknown; content?: unknown };
  if (m.role !== "tool" || !Array.isArray(m.content)) return;

  for (const part of m.content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== "object") continue;
    if (part.type !== "tool-result") continue;
    const callId = typeof part.toolCallId === "string" ? part.toolCallId : undefined;
    if (!callId) continue;
    const description = bridgedDescriptions.get(callId);
    if (!description) continue;

    // Already injected (idempotent — scrub may run twice in retry paths).
    if (part._visionInjected === true) continue;

    const out = part.output;
    // AI SDK v5 shape: output: { type: "content", value: [{type:"text"|"image"...}] }
    if (
      out &&
      typeof out === "object" &&
      (out as Record<string, unknown>).type === "content" &&
      Array.isArray((out as Record<string, unknown>).value)
    ) {
      const value = (out as { value: Array<Record<string, unknown>> }).value;
      value.push({ type: "text", text: `\n${description}\n` });
    } else if (typeof out === "string") {
      (part as Record<string, unknown>).output = `${out}\n\n${description}`;
    } else if (out && typeof out === "object") {
      (out as Record<string, unknown>)._visionDescription = description;
    } else {
      (part as Record<string, unknown>).output = description;
    }
    part._visionInjected = true;
  }
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
  responseFormat?: { type: "json_object" },
): Promise<string | null> {
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
    if (timedOut) {
      console.warn(`[vision-bridge] ${model} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      return null;
    }
    if (signal?.aborted) throw err;
    console.warn(`[vision-bridge] ${model} network error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  clearTimeout(timeout);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(`[vision-bridge] ${model} HTTP ${res.status}: ${errText.slice(0, 200)}`);
    return null;
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  return data?.choices?.[0]?.message?.content ?? null;
}

function formatBridgeResult(description: string, imageCount: number, model: string, contextType: string): string {
  const header =
    imageCount > 1
      ? `[Vision Bridge — ${imageCount} images analyzed (${contextType}) via ${model}]`
      : `[Vision Bridge — image analyzed (${contextType}) via ${model}]`;
  return `\n${header}\n${description}\n[/Vision Bridge]\n`;
}
