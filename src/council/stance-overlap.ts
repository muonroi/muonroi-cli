/**
 * src/council/stance-overlap.ts
 *
 * Make two panelists occupying the SAME seat detectable, and prevent it at the
 * point stances are assigned.
 *
 * ## The defect this exists for (run mttwpmu8ee5b)
 *
 * The panel was Researcher / Cost-Controller / Skeptic / Architect. Their
 * round-0 positions:
 *
 *   Researcher:      "…sẽ tốn gấp 3–5 lần chi phí phát triển và bảo trì…"
 *   Cost-Controller: "…sẽ tốn gấp 3-4 lần ngân sách dự tính…"
 *
 * The same claim, twice. By round 2 the Cost-Controller opened "Đồng ý với lộ
 * trình đề xuất" — it agreed rather than pressured, because its ground had
 * already been argued. Four seats produced three positions, and the user paid
 * for four.
 *
 * Nothing could have caught it. The planner prompt asks for distinct lenses
 * ("Avoid overlap" — `buildDebatePlanPrompt`), but that is a soft instruction to
 * a model, and `sanitizeStances` (debate-planner.ts) validates only that `name`
 * and `lens` are non-empty strings. There was no check between "the planner said
 * it would avoid overlap" and "the panel debated".
 *
 * ## Why this shape and not "drop the duplicate seat"
 *
 * Deleting a seat is the cheap fix and the wrong one: the panel loses a voice
 * and a model, and the run gets narrower rather than sharper. What went wrong is
 * that a seat had nothing of its OWN to say — so the repair is to give it back a
 * distinct lens, keeping the seat. `differentiateOverlappingStances` therefore
 * NEVER changes the roster length; it narrows the subsumed seat's lens with an
 * explicit "this ground is already taken, here is yours" clause naming the seat
 * that covers it.
 *
 * ## Why domains, not text similarity
 *
 * The two overlapping lenses above share almost no vocabulary — a Jaccard score
 * over their words is ~0.08, far below anything that could be a threshold
 * without firing on every panel. What they share is the QUESTION they answer:
 * "what does this cost?". So the primary signal is the set of lens DOMAINS a
 * seat claims, and overlap means one seat's domains are wholly contained in
 * another's — it can contribute nothing the other seat does not already own.
 * Near-verbatim duplicates (which carry no domain keyword at all) are caught by
 * a token-overlap fallback.
 *
 * Pure and dependency-free, so both rules are unit-testable without a debate.
 */

import type { DebateStance } from "./types.js";

/** A lens domain — the question a seat exists to answer. */
export type StanceDomain =
  | "cost"
  | "risk"
  | "architecture"
  | "product"
  | "evidence"
  | "security"
  | "operations"
  | "quality"
  | "data";

/**
 * Domain vocabulary. Deliberately small and concrete: every term is a word a
 * planner-written lens actually uses. A term appearing in a seat's `name` or
 * `lens` claims that domain for the seat. `focus` is excluded on purpose — the
 * Experience Auditor stance stuffs up to 300 chars of brain warnings in there
 * (debate-planner.ts `injectAuditorStance`), which would claim every domain.
 */
const DOMAIN_TERMS: Record<StanceDomain, readonly string[]> = {
  cost: ["cost", "costs", "budget", "spend", "spending", "price", "pricing", "expensive", "roi", "effort", "cheaper"],
  risk: ["risk", "risks", "skeptic", "skeptical", "failure", "fail", "break", "breaks", "regression", "blast", "edge"],
  architecture: [
    "architecture",
    "architect",
    "design",
    "coupling",
    "boundary",
    "boundaries",
    "module",
    "modules",
    "abstraction",
    "structure",
  ],
  product: ["product", "user", "users", "customer", "scope", "mvp", "adoption", "value", "ship", "shipping"],
  evidence: [
    "evidence",
    "research",
    "researcher",
    "benchmark",
    "benchmarks",
    "measure",
    "measured",
    "data-driven",
    "prior",
    "cite",
    "citation",
    "source",
    "sources",
  ],
  security: ["security", "secure", "auth", "authentication", "authorization", "threat", "vulnerability", "attack"],
  operations: [
    "ops",
    "operations",
    "deploy",
    "deployment",
    "release",
    "rollback",
    "monitoring",
    "observability",
    "maintenance",
    "maintain",
    "migration",
    "runbook",
  ],
  quality: ["test", "tests", "testing", "qa", "coverage", "correctness", "verify", "verification", "regression-suite"],
  data: ["schema", "migration-path", "database", "persistence", "index", "query", "consistency", "storage"],
};

const ALL_DOMAINS = Object.keys(DOMAIN_TERMS) as StanceDomain[];

/** Marker appended by `differentiateOverlappingStances`; also the idempotence key. */
const DIFFERENTIATION_MARKER = "Ground already taken:";

/** Lowercase word tokens; unicode-aware so a non-English lens still tokenizes. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((t) => t.length >= 3);
}

/**
 * The lens domains a seat claims, from its `name` and `lens`.
 * An empty set means "no recognized domain" — never treat that as agreement
 * with another empty set; the token fallback handles those.
 */
export function stanceDomains(stance: DebateStance): Set<StanceDomain> {
  const tokens = new Set(tokenize(`${stance.name} ${stance.lens}`));
  const out = new Set<StanceDomain>();
  for (const domain of ALL_DOMAINS) {
    if (DOMAIN_TERMS[domain].some((term) => tokens.has(term))) out.add(domain);
  }
  return out;
}

/** One seat whose contribution is already covered by another seat. */
export interface StanceOverlap {
  /** Index of the seat that has nothing of its own left to argue. */
  subsumedIndex: number;
  /** Index of the seat that already covers it. */
  coveredByIndex: number;
  /** The domains they share; empty when the match came from the token fallback. */
  shared: StanceDomain[];
  /** How the overlap was found — useful when reporting it. */
  kind: "domain-subset" | "near-duplicate";
}

/** Token-overlap ratio (Jaccard) between two seats, including `focus`. */
function tokenSimilarity(a: DebateStance, b: DebateStance): number {
  const ta = new Set(tokenize(`${a.name} ${a.lens} ${a.focus ?? ""}`));
  const tb = new Set(tokenize(`${b.name} ${b.lens} ${b.focus ?? ""}`));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Two seats are near-duplicates when most of their words are the same. 0.5 is
 * deliberately high: below it, two genuinely different lenses on the same topic
 * (which share the topic's nouns) would trip it.
 */
const NEAR_DUPLICATE_RATIO = 0.5;

/**
 * Seats whose lens is wholly covered by an earlier seat's.
 *
 * Reported at most once per seat, always against the EARLIEST seat that covers
 * it, so a three-way collapse yields two reports rather than three and the
 * repair is deterministic.
 */
export function detectStanceOverlap(stances: readonly DebateStance[]): StanceOverlap[] {
  const domains = stances.map(stanceDomains);
  const out: StanceOverlap[] = [];
  for (let i = 1; i < stances.length; i++) {
    const mine = domains[i]!;
    for (let j = 0; j < i; j++) {
      const theirs = domains[j]!;
      if (mine.size > 0 && [...mine].every((d) => theirs.has(d))) {
        out.push({ subsumedIndex: i, coveredByIndex: j, shared: [...mine].sort(), kind: "domain-subset" });
        break;
      }
      if (tokenSimilarity(stances[i]!, stances[j]!) >= NEAR_DUPLICATE_RATIO) {
        out.push({ subsumedIndex: i, coveredByIndex: j, shared: [], kind: "near-duplicate" });
        break;
      }
    }
  }
  return out;
}

/**
 * Narrow every subsumed seat so it argues something the covering seat does not.
 *
 * The roster length is never changed and the covering seat is never touched. The
 * subsumed seat keeps its own lens and gains an explicit instruction naming the
 * seat that owns the shared ground, so "I agree with them" stops being a
 * defensible turn for it.
 *
 * Idempotent: a seat that already carries the marker is skipped, so re-running
 * the plan pipeline (retry, resume) cannot stack clauses.
 */
export function differentiateOverlappingStances(stances: readonly DebateStance[]): {
  stances: DebateStance[];
  overlaps: StanceOverlap[];
} {
  const pending = detectStanceOverlap(stances).filter(
    (o) => !stances[o.subsumedIndex]!.lens.includes(DIFFERENTIATION_MARKER),
  );
  if (pending.length === 0) return { stances: [...stances], overlaps: [] };

  const out = [...stances];
  for (const overlap of pending) {
    const seat = out[overlap.subsumedIndex]!;
    const cover = out[overlap.coveredByIndex]!;
    const sharedText =
      overlap.shared.length > 0 ? `the ${overlap.shared.join(" / ")} angle` : "the angle you were about to take";
    out[overlap.subsumedIndex] = {
      ...seat,
      lens:
        `${seat.lens} ` +
        `${DIFFERENTIATION_MARKER} the "${cover.name}" seat already argues ${sharedText} ` +
        `("${cover.lens}"). Do NOT restate it and do NOT open by agreeing with it. ` +
        `Your turn is only worth its cost if it carries something that seat structurally ` +
        `cannot see — name that, and press there.`,
    };
  }
  return { stances: out, overlaps: pending };
}
