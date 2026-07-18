import { Semantic } from "@muonroi/agent-harness-opentui";
import type { CouncilStatusData } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { resolveCouncilLiveness } from "./council-now.js";

/**
 * `council-strip` — the <96-col fallback for the rail. Concept 4 refuses to
 * mid-word-truncate a squeezed rail; instead the rail unmounts to a single
 * priority-ordered line and DROPS whole sections that don't fit, surfacing the
 * dropped count as a `…+N` overflow chip (k9s header-collapse philosophy).
 *
 * Priority (spec): Liveness > Phase > Speaker(round) > Cost > Roster. Cost has
 * no honest data source, so it is absent here. The liveness segment is the
 * single most-protected element and always leads — it is never dropped.
 */

const SEP = " │ ";

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatAge(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export interface CouncilStripSegment {
  key: string;
  text: string;
}

/**
 * Pack priority-ordered segments into `width`. segments[0] is the protected
 * leader and is always kept (truncation-free — if even it can't fit, it is
 * shown whole and allowed to overflow, never sliced). Each following segment is
 * kept only if it fits WHOLE alongside a room reservation for the `…+N` chip.
 */
export function packStripSegments(
  segments: CouncilStripSegment[],
  width: number,
): { kept: CouncilStripSegment[]; dropped: number } {
  if (segments.length === 0) return { kept: [], dropped: 0 };
  const [lead, ...rest] = segments;
  const kept: CouncilStripSegment[] = [lead];
  let used = lead.text.length;
  let dropped = 0;
  for (let i = 0; i < rest.length; i++) {
    const seg = rest[i];
    const remainingAfter = rest.length - 1 - i;
    // Reserve room for a "…+N" chip when anything might still be dropped.
    const chipReserve = remainingAfter > 0 || dropped > 0 ? SEP.length + 4 : 0;
    const cost = SEP.length + seg.text.length;
    if (used + cost + chipReserve <= width) {
      kept.push(seg);
      used += cost;
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

export interface CouncilStripProps {
  status: CouncilStatusData | null;
  waiting?: boolean;
  roundLabel?: string | null;
  phaseLabel?: string | null;
  panel?: string[];
  width: number;
  theme: Theme;
}

export function CouncilStrip({
  status,
  waiting = false,
  roundLabel,
  phaseLabel,
  panel,
  width,
  theme,
}: CouncilStripProps) {
  const liveness = resolveCouncilLiveness(status, waiting);
  const chars = status?.streamedChars ?? 0;
  const ageMs = status?.lastDeltaAgeMs;
  const role = status?.role || status?.label || "council";

  // Priority-ordered segments (liveness leads, always kept).
  const livenessText =
    liveness === "waiting"
      ? "⏸ waiting"
      : liveness === "idle"
        ? "○ idle"
        : `● ${role} ${formatChars(chars)}↑${ageMs !== undefined ? ` Δ${formatAge(ageMs)}` : ""}`;

  const segments: CouncilStripSegment[] = [{ key: "now", text: livenessText }];
  if (phaseLabel) segments.push({ key: "phase", text: phaseLabel });
  if (roundLabel) segments.push({ key: "round", text: roundLabel });
  if (panel && panel.length > 0) {
    segments.push({ key: "roster", text: panel.map((p) => p.slice(0, 3)).join(" ") });
  }

  const { kept, dropped } = packStripSegments(segments, Math.max(12, width - 2));
  const livenessColor =
    liveness === "alive"
      ? theme.diffAddedFg
      : liveness === "stalled"
        ? theme.initFormError
        : liveness === "waiting"
          ? theme.planOptionSelected
          : theme.textMuted;

  return (
    <Semantic
      id="council-strip"
      role="banner"
      name="Council status"
      props={{ liveness, streamedChars: chars, dropped, alive: liveness === "alive", waiting: liveness === "waiting" }}
    >
      <box flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text>
          {kept.map((seg, idx) => (
            <span
              key={seg.key}
              style={{ fg: idx === 0 ? livenessColor : theme.textMuted }}
            >{`${idx === 0 ? "" : SEP}${seg.text}`}</span>
          ))}
          {dropped > 0 ? <span style={{ fg: theme.textDim }}>{`${SEP}…+${dropped}`}</span> : null}
        </text>
      </box>
    </Semantic>
  );
}
