/**
 * Preserve-verbatim marker handling for two-pass compaction.
 *
 * Content between <!-- preserve --> and <!-- /preserve --> markers
 * survives compaction regardless of token budget.
 */

export const PRESERVE_OPEN = "<!-- preserve -->";
export const PRESERVE_CLOSE = "<!-- /preserve -->";

export interface PreservedBlock {
  id: string;
  content: string;
}

const PRESERVE_RE = /<!-- preserve -->([\s\S]*?)<!-- \/preserve -->/g;

/**
 * Extract content between preserve markers, replacing with placeholders.
 * Unmatched (unclosed) markers are left as-is.
 */
export function extractPreservedBlocks(text: string): {
  cleaned: string;
  blocks: PreservedBlock[];
} {
  const blocks: PreservedBlock[] = [];
  let index = 0;

  const cleaned = text.replace(PRESERVE_RE, (_match, content: string) => {
    const id = `__PRESERVED_${index}__`;
    blocks.push({ id, content });
    index++;
    return id;
  });

  return { cleaned, blocks };
}

/**
 * Replace placeholders with original content wrapped in preserve markers.
 */
export function restorePreservedBlocks(text: string, blocks: PreservedBlock[]): string {
  let result = text;
  for (const block of blocks) {
    result = result.replace(block.id, `${PRESERVE_OPEN}${block.content}${PRESERVE_CLOSE}`);
  }
  return result;
}
