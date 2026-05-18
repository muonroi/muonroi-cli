import type { UINode } from "./protocol.js";

export type Op = "=" | "~=" | "*=" | "^=";
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
  const rawSegments = input.split(childCombinatorRegex);

  // If there's only one segment and no >> was found, combinators = [" "]
  // If there are N segments, there are N-1 >> combinators
  const combinators: string[] = [];
  if (rawSegments.length === 1) {
    combinators.push(" ");
  } else {
    for (let i = 0; i < rawSegments.length - 1; i++) {
      combinators.push(">>");
    }
  }

  // Parse the first segment (for single-segment selectors, this is the only one)
  const terms = parseSegment(rawSegments[0]);

  const result: Selector = {
    terms,
    combinators,
  };

  // If multiple segments, build an array of leaf selectors
  if (rawSegments.length > 1) {
    const leafSegments: Selector[] = [{ terms, combinators: [] }];
    for (let i = 1; i < rawSegments.length; i++) {
      const segTerms = parseSegment(rawSegments[i]);
      leafSegments.push({ terms: segTerms, combinators: [] });
    }
    result.segments = leafSegments;
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

    // Check for key=value, key~=value, key*=value, or key^=value.
    // Key can contain dots (e.g., props.scrollTop).
    // Match longer operators first: *=, ~=, ^=, then =.
    const kvMatch = current.match(/^([\w.]+)(\*=|~=|\^=|=)/);
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

function termMatches(node: UINode, t: Term): boolean {
  if (t.key === "__flag") {
    if (t.value === "focus") return node.focus === true;
    if (t.value === "selected") return node.selected === true;
    if (t.value === "disabled") return node.disabled === true;
    return false;
  }
  if (t.key === "__index") return true;
  const v = readField(node, t.key);
  if (v === undefined) return false;
  const s = String(v);
  if (t.op === "=") return s === t.value;
  if (t.op === "~=") return s.toLowerCase().includes(t.value.toLowerCase());
  if (t.op === "*=") return new RegExp(t.value).test(s);
  if (t.op === "^=") return s.startsWith(t.value);
  return false;
}

function readField(node: UINode, key: string): unknown {
  if (key === "role") return node.role;
  if (key === "id") return node.id;
  if (key === "name") return node.name;
  if (key === "value") return node.value;
  if (key === "state") return node.state;
  if (key.startsWith("props.")) {
    const dot = key.slice("props.".length);
    return (node.props ?? {})[dot];
  }
  return undefined;
}

function termsMatch(node: UINode, terms: Term[]): boolean {
  return terms.filter((t) => t.key !== "__index").every((t) => termMatches(node, t));
}

function indexOf(terms: Term[]): number | undefined {
  const t = terms.find((t) => t.key === "__index");
  return t ? parseInt(t.value, 10) : undefined;
}

function walk(node: UINode, fn: (n: UINode) => void): void {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

export function matchSelector(root: UINode, sel: string): UINode[] {
  const parsed = parseSelector(sel);
  const segments = parsed.segments ?? [{ terms: parsed.terms, combinators: [] }];

  let candidates: UINode[] = [root];
  for (let s = 0; s < segments.length; s++) {
    const segTerms = segments[s].terms;
    const idx = indexOf(segTerms);
    const nextCandidates: UINode[] = [];
    for (const parent of candidates) {
      const segMatches: UINode[] = [];
      if (s === 0) {
        walk(parent, (n) => {
          if (termsMatch(n, segTerms)) segMatches.push(n);
        });
      } else {
        for (const c of parent.children ?? []) {
          if (termsMatch(c, segTerms)) segMatches.push(c);
        }
      }
      if (idx !== undefined) {
        if (segMatches[idx]) nextCandidates.push(segMatches[idx]);
      } else {
        nextCandidates.push(...segMatches);
      }
    }
    candidates = nextCandidates;
  }
  return candidates;
}
