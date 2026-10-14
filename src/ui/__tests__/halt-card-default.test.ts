/**
 * The halt card's rendered side of the one-slot rule.
 *
 * `deriveHaltRecommendation` is unit-covered in
 * `src/product-loop/__tests__/halt-recommendation.test.ts`. What THIS file pins
 * is that the card and the hook both read that one answer:
 *
 * - the row tagged "recommended", the row the cursor starts on and the reason
 *   line printed under the title all come from the same call, so the card can no
 *   longer show a reason arguing for one option beside a default on another
 *   (the post-debate card's defect — 109aeef7);
 * - no destructive row is ever the one the card renders as selected;
 * - `use-app-logic.tsx` opens the card through the single `openHaltCard` path
 *   that seeds the index from the derivation. That file is `@ts-nocheck` with no
 *   hook harness, so its wiring is asserted at source level — before this,
 *   every one of its four open sites called `setHaltSelectedIndex(0)`, and on
 *   the CB-3 card index 0 is "Init new project".
 *
 * Component strategy mirrors modal-focus-publication.test.tsx: these are pure
 * function components, so they are invoked directly and the returned element
 * tree is read — no render engine needed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_RECOVERY_OPTION_IDS, deriveHaltRecommendation } from "../../product-loop/halt-recommendation.js";
import type { HaltChunk, RecoveryOption } from "../../product-loop/types.js";
import { HaltRecoveryCard } from "../components/halt-recovery-card.js";
import type { Theme } from "../theme.js";

const THEME = {} as Theme;
const HOOK_PATH = fileURLToPath(new URL("../use-app-logic.tsx", import.meta.url));

const ALL_OPTION_IDS: readonly RecoveryOption["id"][] = [
  "init_new",
  "point_to_existing",
  "continue_as_council",
  "resume",
  "retry",
  "skip_verify",
  "abort",
];

function option(id: RecoveryOption["id"]): RecoveryOption {
  return { id, label: `Label for ${id}`, description: `What ${id} does.` };
}

function halt(recovery_options: RecoveryOption[], extra: Partial<HaltChunk> = {}): HaltChunk {
  return { type: "halt", reason: "no_recipe", recovery_options, ...extra };
}

// biome-ignore lint/suspicious/noExplicitAny: reaching into React element internals for a pure-function assertion
type El = any;

/** Every element in the tree, depth-first. */
function walk(node: El, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  walk(node.props?.children, out);
  return out;
}

/** The option rows, in render order, with the props the card computed for each. */
function optionRows(element: El): Array<{ id: string; name: string; selected: boolean; props: El }> {
  return walk(element)
    .filter((n) => typeof n.props?.id === "string" && n.props.id.startsWith("halt-option-"))
    .map((n) => ({
      id: String(n.props.id).replace("halt-option-", ""),
      name: String(n.props.name),
      selected: n.props.selected === true,
      props: n.props.props ?? {},
    }));
}

/** Every string the card put anywhere in its element tree. */
function renderedText(node: El, out: string[] = []): string {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) renderedText(child, out);
  } else if (node && typeof node === "object") {
    renderedText(node.props?.children, out);
  }
  return out.join("\n");
}

/** All 2^7 subsets of the option ids, each in list order. */
function everyOptionList(): RecoveryOption[][] {
  const lists: RecoveryOption[][] = [];
  for (let mask = 1; mask < 1 << ALL_OPTION_IDS.length; mask++) {
    lists.push(ALL_OPTION_IDS.filter((_, i) => (mask & (1 << i)) !== 0).map(option));
  }
  return lists;
}

describe("HaltRecoveryCard renders one answer, not three", () => {
  it("tags the recommended row, selects the same row, and prints that row's reason", () => {
    const violations: string[] = [];
    for (const options of everyOptionList()) {
      for (const advice of [
        undefined,
        { action: "Point it at the tests", locus: "recipe" as const, sprintCanCarryIt: false },
        { action: "Fix the broken tests", locus: "code" as const, sprintCanCarryIt: true },
        { action: "Install the missing module", locus: "environment" as const, sprintCanCarryIt: false },
      ]) {
        const chunk = halt(options, advice ? { advice } : {});
        const rec = deriveHaltRecommendation(chunk);
        const element = HaltRecoveryCard({
          halt: chunk,
          // What openHaltCard seeds — the same derivation, the same chunk.
          selectedIndex: rec.index,
          terminalCols: 120,
          theme: THEME,
        });
        const rows = optionRows(element);
        const where = `[${options.map((o) => o.id).join(",")}] locus=${advice?.locus ?? "(none)"}`;

        if (rows.length !== options.length) violations.push(`${where}: rendered ${rows.length} of ${options.length}`);

        const selected = rows.filter((r) => r.selected);
        const tagged = rows.filter((r) => r.props.recommended === true);
        const preselected = rows.filter((r) => r.props.preselected === true);

        if (rec.index < 0) {
          if (selected.length !== 0) violations.push(`${where}: nothing recommended but ${selected.length} selected`);
          if (tagged.length !== 0) violations.push(`${where}: nothing recommended but a row is tagged`);
        } else {
          if (selected.length !== 1) violations.push(`${where}: ${selected.length} rows selected`);
          else if (selected[0].id !== rec.optionId) {
            violations.push(`${where}: selected ${selected[0].id}, recommendation says ${rec.optionId}`);
          }
          if (preselected.length !== 1 || preselected[0].id !== rec.optionId) {
            violations.push(`${where}: preselected prop does not match ${rec.optionId}`);
          }
          if (tagged.length > 1) violations.push(`${where}: ${tagged.length} rows tagged recommended`);
          if (tagged.length === 1 && tagged[0].id !== rec.optionId) {
            violations.push(`${where}: tagged ${tagged[0].id}, recommendation says ${rec.optionId}`);
          }
          // The reason the card prints names the row the card selected.
          const text = renderedText(element);
          if (!text.includes(rec.reason)) violations.push(`${where}: reason line missing from the card`);
          if (!rec.reason.includes(selected[0].name)) {
            violations.push(`${where}: reason does not name the selected row ${selected[0].name}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never renders a destructive row as the selected one", () => {
    const violations: string[] = [];
    for (const options of everyOptionList()) {
      const chunk = halt(options);
      const element = HaltRecoveryCard({
        halt: chunk,
        selectedIndex: deriveHaltRecommendation(chunk).index,
        terminalCols: 120,
        theme: THEME,
      });
      for (const row of optionRows(element)) {
        if (row.selected && DESTRUCTIVE_RECOVERY_OPTION_IDS.has(row.id as RecoveryOption["id"])) {
          violations.push(`[${options.map((o) => o.id).join(",")}] selected destructive ${row.id}`);
        }
        const flaggedDestructive = row.props.destructive === true;
        const isDestructive = DESTRUCTIVE_RECOVERY_OPTION_IDS.has(row.id as RecoveryOption["id"]);
        if (flaggedDestructive !== isDestructive)
          violations.push(`${row.id}: destructive prop is ${flaggedDestructive}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the CB-3 card no longer pre-selects Init new project", () => {
    const chunk = halt([option("init_new"), option("point_to_existing"), option("continue_as_council")], {
      advice: {
        action: "Point /ideal at the sub-project that holds the tests",
        locus: "recipe",
        sprintCanCarryIt: false,
      },
    });
    const rec = deriveHaltRecommendation(chunk);
    const rows = optionRows(
      HaltRecoveryCard({ halt: chunk, selectedIndex: rec.index, terminalCols: 120, theme: THEME }),
    );
    expect(rows[0].id).toBe("init_new");
    expect(rows[0].selected).toBe(false);
    expect(rows[1].id).toBe("point_to_existing");
    expect(rows[1].selected).toBe(true);
    expect(rows[1].props.recommended).toBe(true);
  });
});

describe("use-app-logic.tsx opens the halt card through the derivation", () => {
  const source = readFileSync(HOOK_PATH, "utf8");

  it("sets the halt card and its index together in one place", () => {
    // Every remaining direct setActiveHaltCard call must be a DISMISS (null).
    const directOpens = [...source.matchAll(/setActiveHaltCard\((?!null\))/g)];
    expect(directOpens).toHaveLength(1); // the one inside openHaltCard
    expect(source).toContain("setHaltSelectedIndex(deriveHaltRecommendation(halt).index)");
  });

  it("opens every card through openHaltCard", () => {
    // 3 real sites + 2 test seams were 5 `setActiveHaltCard(chunk)` calls with a
    // hard-coded `setHaltSelectedIndex(0)` beside each.
    const opens = [...source.matchAll(/openHaltCard\(/g)];
    expect(opens.length).toBeGreaterThanOrEqual(5);
    expect(source).not.toMatch(/setActiveHaltCard\(chunk\.haltChunk\)/);
  });

  it("Enter does nothing while nothing is pre-selected", () => {
    expect(source).toContain("if (haltSelectedIndex < 0) return;");
  });
});
