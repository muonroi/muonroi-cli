import { renderMarkdown } from "./markdown-render.js";
import type { Theme } from "./theme";

/**
 * Render markdown to themed TUI text.
 *
 * Historically this delegated to opentui's `<markdown>` renderable with
 * `conceal`, but the bundled @opentui/core (0.1.107) ignores `conceal` and
 * leaves `**`/`###`/`` ` `` markers visible (and frequently fails to load the
 * tree-sitter wasm for highlighting). We now render markdown ourselves via
 * `renderMarkdown`, which strips markers and applies theme colors. See
 * markdown-render.tsx for the construct coverage.
 */
export function Markdown({ content, t }: { content: string; t: Theme }) {
  return renderMarkdown(content, t);
}
