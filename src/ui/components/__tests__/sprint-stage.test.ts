/**
 * Stage-aware Context Rail + main-panel sprint status strip.
 *
 * (a) the rail shows the stage block for the ACTIVE sprint stage (divider
 *     title + compact stage rows, council detail rows dropped), and
 * (b) the main panel receives a live status line during implement (headline
 *     "▸ implementing (41s)" + activity echoes + summary footer).
 */
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SprintProgressSegment } from "../../../state/status-bar-store.js";
import type { CouncilPhaseEvent } from "../../../types/index.js";
import { dark } from "../../theme.js";
import { ContextRail } from "../context-rail.js";
import {
  buildStageDividerTitle,
  buildStageRows,
  deriveSprintStage,
  formatElapsed,
  formatSprintStripHeadline,
  formatSprintStripLine,
  pushActivity,
} from "../sprint-stage.js";
import { SprintStatusStrip } from "../sprint-status-strip.js";

const NOW = 1_750_000_000_000;

function phase(over: Partial<CouncilPhaseEvent>): CouncilPhaseEvent {
  return {
    phaseId: "p",
    kind: "sprint_stage",
    state: "active",
    label: "Sprint 1 — Planning",
    ...over,
  };
}

const seg: SprintProgressSegment = {
  activeSprintNumber: 1,
  totalSprints: 4,
  completedStories: 2,
  totalStories: 2,
  overallPct: 25,
};

/** Flatten every string in a React element tree (no renderer needed). */
function collectText(node: ReactNode, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectText(c, out);
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.props) collectText(el.props.children, out);
  return out;
}

describe("deriveSprintStage", () => {
  it("returns the most recent ACTIVE sprint_stage phase", () => {
    const phases: CouncilPhaseEvent[] = [
      phase({ phaseId: "sprint-1-planning", state: "done" }),
      phase({
        phaseId: "sprint-1-implementation",
        label: "Sprint 1 — Implementation",
        detail: "Orchestrator executing sprint plan",
        startedAt: NOW - 41_000,
      }),
    ];
    const info = deriveSprintStage(phases);
    expect(info?.stage).toBe("implementation");
    expect(info?.stageShort).toBe("impl");
    expect(info?.sprintN).toBe(1);
    expect(info?.phaseId).toBe("sprint-1-implementation");
  });

  it("returns null when no sprint stage is active (done phases / pure council)", () => {
    expect(deriveSprintStage([phase({ state: "done" })])).toBeNull();
    expect(deriveSprintStage([phase({ kind: "round" })])).toBeNull();
    expect(deriveSprintStage([])).toBeNull();
  });

  it("maps every known stage label", () => {
    for (const [label, short] of [
      ["Sprint 2 — Planning", "plan"],
      ["Sprint 2 — Implementation", "impl"],
      ["Sprint 2 — Verification", "verify"],
      ["Sprint 2 — Judgment", "judge"],
    ] as const) {
      expect(deriveSprintStage([phase({ label })])?.stageShort).toBe(short);
    }
  });
});

describe("stage rail block", () => {
  it("divider title reads SPRINT n/m · stage", () => {
    const info = deriveSprintStage([phase({ label: "Sprint 1 — Implementation" })]);
    expect(buildStageDividerTitle(info!, seg)).toBe("SPRINT 1/4 · impl");
    // Falls back to the parsed sprint number without a segment.
    expect(buildStageDividerTitle(info!, undefined)).toBe("SPRINT 1 · impl");
  });

  it("implementation rows show live activity + stories/elapsed, no criteria dump", () => {
    const info = deriveSprintStage([phase({ label: "Sprint 1 — Implementation", startedAt: NOW - 41_000 })]);
    const rows = buildStageRows({
      info: info!,
      sprint: seg,
      lastActivity: "Edit src/sandbox/gate.ts",
      now: NOW,
    });
    expect(rows[0]?.value).toBe("▸ Edit src/sandbox/gate.ts");
    expect(rows[1]?.value).toBe("  2/2 stories · 41s");
    expect(rows.length).toBe(2);
  });

  it("planning rows show topic + live round progress", () => {
    const info = deriveSprintStage([phase({ label: "Sprint 1 — Planning", startedAt: NOW - 5_000 })]);
    const rows = buildStageRows({
      info: info!,
      sprint: seg,
      topic: "Plan sprint 1 for product: counter",
      councilProgress: "Round 1/3 · running",
      criteriaSummary: "0/3 criteria met",
      now: NOW,
    });
    const values = rows.map((r) => r.value);
    expect(values).toContain("▸ Plan sprint 1 for product: counter");
    expect(values).toContain("  Round 1/3 · running");
    expect(values).toContain("  0/3 criteria met");
  });

  it("ContextRail renders the stage divider + rows and exposes them to the harness", () => {
    const el = ContextRail({
      width: 36,
      rows: [
        { label: "Session", value: "3b121b52" },
        { label: "Model", value: "m" },
      ],
      stage: { title: "SPRINT 1/4 · impl", rows: [{ label: "", value: "▸ module-hook.ts" }] },
    });
    // Semantic wrapper props (harness surface).
    const semProps = (el as ReactElement<{ props: Record<string, unknown> }>).props.props as Record<string, unknown>;
    expect(semProps.stageTitle).toBe("SPRINT 1/4 · impl");
    expect(semProps.rowCount).toBe(3); // identity rows + stage rows combined
    expect(String(semProps.values)).toContain("▸ module-hook.ts");
    // Visible divider text contains the stage title.
    const texts = collectText(el);
    expect(texts.some((s) => s.includes("SPRINT 1/4 · impl"))).toBe(true);
    expect(texts).toContain("▸ module-hook.ts");
  });

  it("ContextRail without a stage keeps the legacy props shape", () => {
    const el = ContextRail({ width: 36, rows: [{ label: "Session", value: "abc" }] });
    const semProps = (el as ReactElement<{ props: Record<string, unknown> }>).props.props as Record<string, unknown>;
    expect(semProps.rowCount).toBe(1);
    expect(semProps.stageTitle).toBe("");
  });
});

describe("SprintStatusStrip (main panel live status)", () => {
  it("shows a ticking headline, activity echoes, and the summary footer during implement", () => {
    const info = deriveSprintStage([phase({ label: "Sprint 1 — Implementation", startedAt: NOW - 41_000 })]);
    const el = SprintStatusStrip({
      t: dark,
      info: info!,
      sprint: seg,
      activity: ["Write src/sandbox/gate.ts", "running tsc…"],
      now: NOW,
      width: 80,
    });
    const semantic = el as ReactElement<{ value?: string; props: Record<string, unknown> }>;
    expect(semantic.props.value).toBe("Sprint 1/4 · impl · 2/2 · 41s");
    const texts = collectText(el).join("\n");
    expect(texts).toContain("▸ implementing (41s)");
    expect(texts).toContain("running tsc…");
    expect(texts).toContain("Sprint 1/4 · impl · 2/2 · 41s");
  });

  it("headline/summary formatters tick with now", () => {
    const info = deriveSprintStage([phase({ label: "Sprint 3 — Verification", startedAt: NOW - 192_000 })]);
    expect(formatSprintStripHeadline(info!, NOW)).toBe("▸ verifying (3m12s)");
    expect(formatSprintStripLine(info!, undefined, NOW)).toBe("Sprint 3 · verify · 3m12s");
  });
});

describe("small helpers", () => {
  it("formatElapsed", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(41_000)).toBe("41s");
    expect(formatElapsed(192_000)).toBe("3m12s");
  });

  it("pushActivity dedupes the tail and caps the ring", () => {
    let ring: readonly string[] = [];
    ring = pushActivity(ring, "a");
    ring = pushActivity(ring, "a"); // dedupe
    ring = pushActivity(ring, "b");
    ring = pushActivity(ring, "c");
    ring = pushActivity(ring, "d");
    expect(ring).toEqual(["b", "c", "d"]);
    expect(pushActivity(ring, "")).toBe(ring);
    expect(pushActivity(ring, null)).toBe(ring);
  });
});
