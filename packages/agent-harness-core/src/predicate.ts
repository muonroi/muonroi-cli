import { z } from "zod";
import type { UINode } from "./protocol.js";

const FieldOp = z.object({
  field: z.enum(["name", "value", "state"]),
  op: z.enum(["eq", "neq", "contains", "regex"]),
  rhs: z.string().max(200),
});
const FlagOp = z.object({
  flag: z.enum(["focus", "selected", "disabled"]),
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
