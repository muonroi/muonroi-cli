import type { UINode } from "./protocol.js";

export type Op = "=" | "~=" | "*=";
export type Term = { key: string; op: Op; value: string };
export type Selector = {
  terms: Term[];
  segments?: Selector[];
  combinators: string[];
};

const FLAGS = new Set(["focus", "selected", "disabled"]);

export function parseSelector(input: string): Selector {
  // First, split by child combinator >>
  const childCombinatorRegex = /\s*>>\s*/;
  const segments = input.split(childCombinatorRegex);

  // If there's only one segment and no >> was found, combinators = [" "]
  // If there are N segments, there are N-1 >> combinators
  const combinators: string[] = [];
  if (segments.length === 1) {
    combinators.push(" ");
  } else {
    for (let i = 0; i < segments.length - 1; i++) {
      combinators.push(">>");
    }
  }

  // Parse the first segment (for single-segment selectors, this is the only one)
  const terms = parseSegment(segments[0]);

  const result: Selector = {
    terms,
    combinators,
  };

  // If multiple segments, recursively parse the rest
  if (segments.length > 1) {
    const rest = segments.slice(1).join(" >> ");
    const restSelector = parseSelector(rest);
    result.segments = [result, restSelector];
  }

  return result;
}

function parseSegment(input: string): Term[] {
  const terms: Term[] = [];
  let current = input.trim();

  while (current) {
    current = current.trim();
    if (!current) break;

    // Check for [index=N]
    const indexMatch = current.match(/^\[index=(\d+)\]/);
    if (indexMatch) {
      terms.push({
        key: "__index",
        op: "=",
        value: indexMatch[1],
      });
      current = current.slice(indexMatch[0].length);
      continue;
    }

    // Check for flag tokens
    const flagMatch = current.match(/^(focus|selected|disabled)(?:\s|$)/);
    if (flagMatch) {
      terms.push({
        key: "__flag",
        op: "=",
        value: flagMatch[1],
      });
      current = current.slice(flagMatch[0].length);
      continue;
    }

    // Check for key=value or key~=value or key*=value
    // Key can contain dots (e.g., props.scrollTop)
    // Match longer operators first: *=, ~=, then =
    const kvMatch = current.match(/^([\w.]+)(\*=|~=|=)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const op = kvMatch[2] as Op;
      const restAfterOp = current.slice(kvMatch[0].length);

      // Parse value - either quoted or unquoted
      let value: string;
      let consumed: number;

      if (restAfterOp.startsWith('"')) {
        // Quoted value
        const endQuote = restAfterOp.indexOf('"', 1);
        if (endQuote !== -1) {
          value = restAfterOp.slice(1, endQuote);
          consumed = kvMatch[0].length + endQuote + 1;
        } else {
          // Malformed, break
          break;
        }
      } else {
        // Unquoted value - take until space or end
        const spaceMatch = restAfterOp.match(/^(\S+)/);
        if (spaceMatch) {
          value = spaceMatch[1];
          consumed = kvMatch[0].length + value.length;
        } else {
          break;
        }
      }

      terms.push({
        key,
        op,
        value,
      });

      current = current.slice(consumed);
      continue;
    }

    // If we can't match anything, break to avoid infinite loop
    break;
  }

  return terms;
}
