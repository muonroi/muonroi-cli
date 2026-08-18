import { Semantic } from "@muonroi/agent-harness-opentui";
import type { CouncilStatusData } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { resolveCouncilLiveness } from "./council-now.js";

/**
 * `council-banner` — the sticky PINNED header at the top of the MAIN transcript
 * pane in the two-pane council surface. It replaces the streamed preamble noise
 * (`[Auto-council triggered]`, `── Opening Analysis ──`, budget line, …) that
 * `stripCouncilNoise` removes from the transcript, promoting the one thing worth
 * pinning to a fixed, always-visible banner instead of a scrolled-past line.
 *
 * The pin is PHASE-AWARE (user request): the same banner shows the grading
 * OUTCOME early, the live ROUND during debate, and the DECISION at synthesis —
 * so whatever the council is currently "about" is always the pinned line.
 *
 *   header:  Council · <convene>            (convene = "heavy · analyze", optional)
 *   body:    Outcome m/n · Round r/total · <liveness>       (debate)
 *            Outcome m/n met · preparing                     (early)
 *            ✓ Decision: <x> · m/n met                       (synthesis)
 *
 * Deliberately compact (2 lines) — it is sticky and must not eat transcript
 * height. The full per-criterion ✓/○ breakdown stays in the rail DETAIL.
 */

export type CouncilBannerPhase = "early" | "debate" | "synthesis";

export interface CouncilBannerProps {
  /** Section title — "Council" or "SPRINT · Council". */
  title: string;
  /** Convene reason ("heavy · analyze"), or null for user-initiated /council. */
  convene: string | null;
  criteriaTotal: number;
  criteriaMet: number;
  /** Latest round number, or null before round 1 starts. */
  roundCurrent: number | null;
  /** Planned budget (max rounds), or undefined. */
  roundTotal?: number;
  /** Active phase label from the PHASES timeline, or null. */
  phaseLabel: string | null;
  /** Live status driving the liveness dot, or null. */
  status: CouncilStatusData | null;
  waiting?: boolean;
  /** Leader's final decision (synthesis phase), or null. */
  decision: string | null;
  width: number;
  theme: Theme;
}

/** Pure phase derivation — decision wins, then any started round, else early. */
export function deriveBannerPhase(roundCurrent: number | null, decision: string | null): CouncilBannerPhase {
  if (decision) return "synthesis";
  if (roundCurrent !== null) return "debate";
  return "early";
}

export function CouncilBanner({
  title,
  convene,
  criteriaTotal,
  criteriaMet,
  roundCurrent,
  roundTotal,
  phaseLabel,
  status,
  waiting = false,
  decision,
  width,
  theme,
}: CouncilBannerProps) {
  const phase = deriveBannerPhase(roundCurrent, decision);
  const liveness = resolveCouncilLiveness(status, waiting);
  const outcome = criteriaTotal > 0 ? `Outcome ${criteriaMet}/${criteriaTotal}` : null;
  const roundSeg = roundCurrent !== null ? `Round ${roundCurrent}${roundTotal ? `/${roundTotal}` : ""}` : null;
  const livenessText =
    liveness === "waiting" ? "waiting" : liveness === "alive" ? "running" : liveness === "stalled" ? "stalled" : "idle";
  const livenessColor =
    liveness === "alive"
      ? theme.diffAddedFg
      : liveness === "stalled"
        ? theme.initFormError
        : liveness === "waiting"
          ? theme.planOptionSelected
          : theme.textMuted;

  // Phase-aware body segments (stable keys — no array-index keys).
  const segs: Array<{ key: string; text: string; fg: string }> = [];
  if (phase === "synthesis") {
    segs.push({ key: "decision", text: `✓ ${decision}`, fg: theme.diffAddedFg });
    if (outcome) segs.push({ key: "met", text: `${criteriaMet}/${criteriaTotal} met`, fg: theme.textMuted });
  } else if (phase === "debate") {
    if (outcome) segs.push({ key: "outcome", text: outcome, fg: theme.textMuted });
    if (roundSeg) segs.push({ key: "round", text: roundSeg, fg: theme.accent });
    if (phaseLabel) segs.push({ key: "phase", text: phaseLabel, fg: theme.textMuted });
    segs.push({ key: "liveness", text: livenessText, fg: livenessColor });
  } else {
    segs.push({ key: "outcome", text: outcome ? `${outcome} met` : "preparing", fg: theme.textMuted });
    segs.push({ key: "phase", text: phaseLabel ?? "opening analysis", fg: theme.textDim });
  }

  const header = convene ? `${title} · ${convene}` : title;
  const SEP = " · ";

  return (
    <Semantic
      id="council-banner"
      role="banner"
      name="Council banner"
      value={header}
      props={{
        phase,
        convene: convene ?? "",
        criteriaMet,
        criteriaTotal,
        roundCurrent: roundCurrent ?? -1,
        roundTotal: roundTotal ?? -1,
        liveness,
        decision: decision ?? "",
        body: segs.map((s) => s.text).join(SEP),
      }}
    >
      <box
        flexShrink={0}
        flexDirection="column"
        width={width}
        border={["left"]}
        borderColor={theme.councilLeaderBorder}
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
      >
        <text fg={theme.councilLeaderBorder} attributes={1}>
          {header}
        </text>
        <text>
          {segs.map((s, idx) => (
            <span key={s.key} style={{ fg: s.fg }}>{`${idx === 0 ? "" : SEP}${s.text}`}</span>
          ))}
        </text>
      </box>
    </Semantic>
  );
}
