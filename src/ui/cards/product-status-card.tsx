/**
 * src/ui/cards/product-status-card.tsx
 *
 * OpenTUI renderer for the `product_status_card` StreamChunk.
 * Mirrors the visual style of CouncilStatusList — bordered/dim labels,
 * inline ASCII bars, color-coded criteria counts.
 *
 * Wire-format: orchestrator yields a StreamChunk with
 * `type: "product_status_card"` and `productStatusCard: ProductStatusCardData`.
 * app.tsx accumulates the latest snapshot and renders this component.
 */

import * as React from "react";
import type { ProductStatusCardData } from "../../product-loop/types.js";
import type { Theme } from "../theme.js";

export interface ProductStatusCardProps {
  data: ProductStatusCardData;
  theme: Theme;
}

function clampPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, (numerator / denominator) * 100));
}

function bar(pct: number, width = 16): string {
  const filled = Math.round((pct / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export function ProductStatusCard({ data, theme: t }: ProductStatusCardProps): React.ReactNode {
  const sprintPct = clampPct(data.sprintN, data.totalSprints);
  const costPct = clampPct(data.costSpent, data.costCap);
  const totalCriteria = data.criteriaMet + data.criteriaPartial + data.criteriaUnmet;
  const costColor = costPct > 80 ? t.diffRemovedFg : t.accent;

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={0} flexShrink={0}>
      <box>
        <text fg={t.accent}>{`▶ Product Loop · ${data.currentStage}`}</text>
      </box>
      <box>
        <text fg={t.textMuted}>{"Sprint:   "}</text>
        <text fg={t.text}>{`${data.sprintN}/${data.totalSprints} `}</text>
        <text fg={t.accent}>{bar(sprintPct)}</text>
        <text fg={t.textDim}>{` ${sprintPct.toFixed(0)}%`}</text>
      </box>
      <box>
        <text fg={t.textMuted}>{"Cost:     "}</text>
        <text fg={t.text}>{`$${data.costSpent.toFixed(2)}/$${data.costCap.toFixed(2)} `}</text>
        <text fg={costColor}>{bar(costPct)}</text>
        <text fg={t.textDim}>{` ${costPct.toFixed(0)}%`}</text>
      </box>
      <box>
        <text fg={t.textMuted}>{"Criteria: "}</text>
        <text fg={t.planOptionCheck}>{`✓ ${data.criteriaMet}`}</text>
        <text fg={t.text}>{"  "}</text>
        <text fg={t.accent}>{`◐ ${data.criteriaPartial}`}</text>
        <text fg={t.text}>{"  "}</text>
        <text fg={t.diffRemovedFg}>{`✗ ${data.criteriaUnmet}`}</text>
        <text fg={t.textDim}>{`  (of ${totalCriteria})`}</text>
      </box>
    </box>
  );
}

export default ProductStatusCard;
