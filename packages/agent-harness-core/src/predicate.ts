import { z } from "zod";
import type { UINode } from "./protocol.js";

/**
 * The `tui.expect` predicate vocabulary.
 *
 * Declared as values, with the zod schemas below built FROM them, so the
 * `tui.capabilities` handshake can advertise the real grammar. Without this an
 * agent holding only capabilities has no way to know that `field` accepts
 * name/value/state and NOT `role` — a live capabilities-only drive of this
 * server got a silent `false` from exactly that mistake.
 */
export const PREDICATE_FIELDS = ["name", "value", "state"] as const;
export const PREDICATE_OPS = ["eq", "neq", "contains", "regex"] as const;
export const PREDICATE_FLAGS = ["focus", "selected", "disabled"] as const;
export const PREDICATE_COMBINATORS = ["all", "any", "not"] as const;

/** Machine-readable predicate grammar for the capabilities handshake. */
export const PREDICATE_GRAMMAR = {
  fields: PREDICATE_FIELDS,
  ops: PREDICATE_OPS,
  flags: PREDICATE_FLAGS,
  combinators: PREDICATE_COMBINATORS,
  forms: [
    '{"field":<field>,"op":<op>,"rhs":<string>} — compare a node field',
    '{"flag":<flag>,"value":<boolean>} — assert a boolean flag',
    '{"all":[<predicate>,…]} / {"any":[<predicate>,…]} / {"not":<predicate>}',
  ],
  opSemantics: {
    eq: "exact string equality",
    neq: "string inequality",
    contains: "case-insensitive substring",
    regex: "JavaScript RegExp test (unanchored)",
  },
  note: "`field` does NOT accept id or role — select those with the selector instead.",
} as const;

const FieldOp = z.object({
  field: z.enum(PREDICATE_FIELDS),
  op: z.enum(PREDICATE_OPS),
  rhs: z.string().max(200),
});
const FlagOp = z.object({
  flag: z.enum(PREDICATE_FLAGS),
  value: z.boolean(),
});

export type Predicate =
  | z.infer<typeof FieldOp>
  | z.infer<typeof FlagOp>
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    FieldOp,
    FlagOp,
    z.object({ all: z.array(predicateSchema) }),
    z.object({ any: z.array(predicateSchema) }),
    z.object({ not: predicateSchema }),
  ]),
);

export function evaluatePredicate(p: Predicate, node: UINode): boolean {
  if ("all" in p) return p.all.every((q) => evaluatePredicate(q, node));
  if ("any" in p) return p.any.some((q) => evaluatePredicate(q, node));
  if ("not" in p) return !evaluatePredicate(p.not, node);
  if ("flag" in p && typeof (p as { flag?: string }).flag === "string") {
    const fp = p as typeof FlagOp extends z.ZodType<infer T> ? T : never;
    const flagVal = fp.flag === "focus" ? node.focus : fp.flag === "selected" ? node.selected : node.disabled;
    return !!flagVal === fp.value;
  }
  const fp = p as typeof FieldOp extends z.ZodType<infer T> ? T : never;
  const v = fp.field === "name" ? node.name : fp.field === "value" ? node.value : node.state;
  const s = v == null ? "" : String(v);
  switch (fp.op) {
    case "eq":
      return s === fp.rhs;
    case "neq":
      return s !== fp.rhs;
    case "contains":
      return s.toLowerCase().includes(fp.rhs.toLowerCase());
    case "regex":
      return new RegExp(fp.rhs).test(s);
    default:
      return false;
  }
}
