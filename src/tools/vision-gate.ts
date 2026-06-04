/**
 * Vision-tool gating.
 *
 * For text-only models the registry adds 3 vision-proxy tools
 * (analyze_image, ask_vision_proxy, list_vision_cache) so the model can "see"
 * images through a proxy. Their schemas carry long descriptions (~500-700
 * input tokens total) and load on EVERY turn for those models — including the
 * overwhelming majority of turns that involve no image at all.
 *
 * This gate drops the 3 vision tools ONLY when the turn cannot possibly need
 * them. The bias is deliberately KEEP-not-drop: vision tools are retained
 * whenever there is any plausible image involvement, so we never strip a
 * capability a real turn needs (the BUG-A failure mode). They are dropped only
 * when ALL of these are false:
 *   - the message text references an image (path/extension/data-uri/keyword),
 *   - the turn's messages carry an actual image content part (attachment),
 *   - there are cached images from earlier turns (a follow-up may query them),
 *   - a prior turn already issued tool calls (conservative continuation guard).
 *
 * `todo_write` and all core code tools are NEVER affected by this gate.
 */

/** The exact tool ids this gate governs. Core/code/todo tools are excluded. */
export const VISION_TOOL_NAMES = ["analyze_image", "ask_vision_proxy", "list_vision_cache"] as const;

/**
 * Image references in free text: an image file extension, a data: image URI, or
 * common image vocabulary (English + Vietnamese). Broad on purpose — a false
 * positive merely KEEPS the vision tools (costs tokens), never drops a needed one.
 */
// Note: \b is ASCII-only, so Vietnamese diacritic terms (ảnh/hình) are matched
// as bare substrings in a trailing alternation rather than inside \b(...)\b.
const IMAGE_SIGNAL_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico)\b|data:image\/|\b(image|images|screenshot|screenshots|screen-?shot|picture|photo|photos|diagram|mockup|wireframe|figma|canva|chart|graph|logo|icon|thumbnail)\b|ảnh|hình|hinh/i;

/** True if any message in the turn carries an image (or image-typed) content part. */
export function messagesHaveImagePart(messages: unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const content = (m as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      if (type === "image" || type === "image_url" || type === "file") return true;
      const mediaType = (part as { mediaType?: unknown }).mediaType;
      if (typeof mediaType === "string" && mediaType.startsWith("image/")) return true;
    }
  }
  return false;
}

export interface VisionGateInput {
  /** The current user message text. */
  userMessage: string;
  /** The full message list for the turn (to detect image attachments). */
  messages?: unknown[];
  /** How many images are cached from earlier turns (ask_vision_proxy targets). */
  cachedImageCount?: number;
  /** Whether a prior turn already issued tool calls (continuation guard). */
  priorTurnHadTools?: boolean;
}

/**
 * Decide whether the 3 vision tools should be included this turn. Returns true
 * (keep) on any plausible image involvement; false (drop) only for a pure-text
 * turn with no image anywhere and no image/tool history.
 */
export function visionToolsNeeded(input: VisionGateInput): boolean {
  if (input.priorTurnHadTools) return true;
  if ((input.cachedImageCount ?? 0) > 0) return true;
  if (messagesHaveImagePart(input.messages)) return true;
  return IMAGE_SIGNAL_RE.test(input.userMessage ?? "");
}
