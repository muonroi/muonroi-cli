import type { UINode } from "./protocol.js";

/**
 * Comparison operators, longest-first — `parseSegment` alternates over this
 * array, so the order here IS the match precedence (`*=` must be tried before
 * `=`). Declared as a value with {@link Op} derived from it so `tui.capabilities`
 * can advertise the real operator set; a type-only union is invisible at runtime
 * and the hand-written docs had already dropped `^=`.
 */
export const SELECTOR_OPS = ["*=", "~=", "^=", "="] as const;
export type Op = (typeof SELECTOR_OPS)[number];

/** Bare boolean flag tokens, e.g. `role=button focus`. Load-bearing: `parseSegment` builds its matcher from this. */
export const SELECTOR_FLAGS = ["focus", "selected", "disabled"] as const;
export type SelectorFlag = (typeof SELECTOR_FLAGS)[number];

/** Node fields a term may compare against, besides dotted `props.<key>` access. Load-bearing in `readField`. */
export const SELECTOR_FIELDS = ["id", "role", "name", "value", "state"] as const;
export type SelectorField = (typeof SELECTOR_FIELDS)[number];

/** Descend-into-children combinator. Load-bearing: `parseSelector` splits on it. */
export const SELECTOR_CHILD_COMBINATOR = ">>";

/** Prefix for dotted access into `UINode.props`. Load-bearing in `readField`. */
export const SELECTOR_PROPS_PREFIX = "props.";

/**
 * Machine-readable description of the selector grammar, for the
 * `tui.capabilities` handshake. `ops`, `flags`, `fields`, `childCombinator` and
 * `propsPrefix` are the SAME values the parser below consumes, so they cannot
 * drift from behaviour. `forms` and `examples` are prose: the shapes they
 * describe (`[index=N]`, quoted values) are encoded in `parseSegment`'s regexes
 * and have no value form to point at — they are restated, and live in this file
 * so a parser change and its description are one edit apart.
 */
export const SELECTOR_GRAMMAR = {
  ops: SELECTOR_OPS,
  flags: SELECTOR_FLAGS,
  fields: SELECTOR_FIELDS,
  childCombinator: SELECTOR_CHILD_COMBINATOR,
  propsPrefix: SELECTOR_PROPS_PREFIX,
  forms: [
    "<field><op><value> — value may be bare (up to the next space) or double-quoted to include spaces",
    "props.<key><op><value> — dotted access into UINode.props",
    "<flag> — bare token, matches when that boolean is true on the node",
    "[index=N] — 0-based positional pick among the matches of the segment it appears in",
    "<segment> >> <segment> — right-hand segment matches DIRECT CHILDREN of the left-hand matches",
    "several terms separated by spaces AND together within one segment",
  ],
  opSemantics: {
    "=": "exact string equality",
    "~=": "case-insensitive substring",
    "*=": "JavaScript RegExp test (unanchored)",
    "^=": "string prefix",
  },
  examples: [
    "role=textbox",
    "id=composer",
    'name~="council"',
    'name*="Co.*l$"',
    "role=listitem focus",
    "role=listitem [index=0]",
    "role=dialog >> role=button",
    "id=log props.overflows=true",
  ],
} as const;

export type Term = { key: string; op: Op; value: string };
export type Selector = {
  terms: Term[];
  segments?: Selector[];
  combinators: string[];
};

/** Escape a literal for embedding in a RegExp source. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FLAG_RE = new RegExp(`^(${SELECTOR_FLAGS.map(reEscape).join("|")})(?:\\s|$)`);
// Keys may contain dots (props.scrollTop). Operators are alternated in
// SELECTOR_OPS order, which is longest-first so `*=` wins over `=`.
const KV_RE = new RegExp(`^([\\w.]+)(${SELECTOR_OPS.map(reEscape).join("|")})`);
const CHILD_COMBINATOR_RE = new RegExp(`\\s*${reEscape(SELECTOR_CHILD_COMBINATOR)}\\s*`);

export function parseSelector(input: string): Selector {
  // First, split by the child combinator (>>)
  const childCombinatorRegex = CHILD_COMBINATOR_RE;
  const rawSegments = input.split(childCombinatorRegex);

  // If there's only one segment and no >> was found, combinators = [" "]
  // If there are N segments, there are N-1 >> combinators
  const combinators: string[] = [];
  if (rawSegments.length === 1) {
    combinators.push(" ");
  } else {
    for (let i = 0; i < rawSegments.length - 1; i++) {
      combinators.push(SELECTOR_CHILD_COMBINATOR);
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

    // Check for flag tokens (derived from SELECTOR_FLAGS)
    const flagMatch = current.match(FLAG_RE);
    if (flagMatch) {
      terms.push({
        key: "__flag",
        op: "=",
        value: flagMatch[1],
      });
      current = current.slice(flagMatch[0].length);
      continue;
    }

    // Check for key<op>value. Key can contain dots (e.g., props.scrollTop).
    // Operator alternation comes from SELECTOR_OPS, which is ordered
    // longest-first so `*=` is tried before `=`.
    const kvMatch = current.match(KV_RE);
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
    if (!(SELECTOR_FLAGS as readonly string[]).includes(t.value)) return false;
    return node[t.value as SelectorFlag] === true;
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
  if ((SELECTOR_FIELDS as readonly string[]).includes(key)) {
    return node[key as SelectorField];
  }
  if (key.startsWith(SELECTOR_PROPS_PREFIX)) {
    const dot = key.slice(SELECTOR_PROPS_PREFIX.length);
    return node.props?.[dot];
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
