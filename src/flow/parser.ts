/**
 * Heading-delimited section parser/writer for .muonroi-flow/ markdown files.
 *
 * All reads are tolerant: missing sections return undefined, empty input returns
 * empty map, malformed input never throws. All writes are deterministic: same
 * sections produce same output.
 */

export interface SectionMap {
  sections: Map<string, string>;
  preamble: string;
}

/**
 * Parse heading-delimited markdown into a SectionMap.
 * Splits on `## Heading` lines. Content before the first heading is the preamble.
 * Empty or malformed input returns empty map with empty preamble (never throws).
 */
export function parseSections(markdown: string): SectionMap {
  const sections = new Map<string, string>();
  let preamble = "";
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const lines = markdown.split("\n");

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      if (currentHeading !== null) {
        sections.set(currentHeading, currentLines.join("\n").trim());
      } else {
        preamble = currentLines.join("\n").trim();
      }
      currentHeading = match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section or preamble
  if (currentHeading !== null) {
    sections.set(currentHeading, currentLines.join("\n").trim());
  } else {
    preamble = currentLines.join("\n").trim();
  }

  return { sections, preamble };
}

/**
 * Serialize a SectionMap back to heading-delimited markdown.
 * Preamble comes first, then headings in the specified order.
 * Headings not in the order array are appended at the end.
 */
export function serializeSections(map: SectionMap, order?: string[]): string {
  const parts: string[] = [];
  if (map.preamble) parts.push(map.preamble);

  const headings = order
    ? [...new Set([...order, ...map.sections.keys()])]
    : [...map.sections.keys()];

  for (const h of headings) {
    const content = map.sections.get(h);
    if (content !== undefined) {
      parts.push(`## ${h}\n\n${content}`);
    }
  }

  return parts.join("\n\n") + "\n";
}

/**
 * Tolerant getter — returns undefined for missing sections, never throws.
 */
export function getSection(map: SectionMap, heading: string): string | undefined {
  return map.sections.get(heading);
}
