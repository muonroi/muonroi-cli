/**
 * src/ui/status-bar/usd-meter.tsx
 *
 * USD meter sub-component: session + month with threshold color escalation.
 * white < 50%, cyan >= 50%, yellow >= 80%, red >= 100%.
 */

import * as React from "react";

export interface UsdMeterProps {
  session_usd: number;
  month_usd: number;
  current_pct: number;
}

export function UsdMeter({ session_usd, month_usd, current_pct }: UsdMeterProps): React.ReactElement {
  const color = current_pct >= 100 ? "red" : current_pct >= 80 ? "yellow" : current_pct >= 50 ? "cyan" : "white";

  const text = `session: $${session_usd.toFixed(2)} | month: $${month_usd.toFixed(2)}`;

  return React.createElement("text", { color, "data-testid": "usd-meter", "data-pct": current_pct }, text);
}
