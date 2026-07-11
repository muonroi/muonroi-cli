/**
 * src/ui/status-bar/usd-meter.tsx
 *
 * USD meter sub-component: session spend with threshold color escalation.
 * white < 50%, cyan >= 50%, yellow >= 80%, red >= 100%. The month total is
 * intentionally NOT shown here (redundant on the status bar); it remains in the
 * store and is surfaced on demand via `/cost`.
 */

import * as React from "react";

export interface UsdMeterProps {
  session_usd: number;
  current_pct: number;
}

export function UsdMeter({ session_usd, current_pct }: UsdMeterProps): React.ReactElement {
  const color = current_pct >= 100 ? "red" : current_pct >= 80 ? "yellow" : current_pct >= 50 ? "cyan" : "white";

  const text = `session: $${session_usd.toFixed(2)}`;

  return React.createElement("text", { fg: color, "data-testid": "usd-meter", "data-pct": current_pct }, text);
}
