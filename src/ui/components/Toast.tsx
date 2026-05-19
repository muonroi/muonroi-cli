/**
 * Phase 21 — Plan 02 / T1
 *
 * Passive toast component for surfacing transient signals (EE timeouts,
 * setting changes, errors). Auto-fades after `durationMs` (default 4000ms).
 *
 * The root is wrapped in `<Semantic id="toast" role="toast" name={text}>` so
 * harness specs can assert on its appearance via `driver.wait_for({selector:
 * "id=toast"})` and read the message via `driver.query("id=toast")?.name`.
 *
 * Styling reuses existing tokens from `src/ui/theme.ts` — no new deps.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type React from "react";
import { useEffect } from "react";
import type { Theme } from "../theme.js";

export type ToastLevel = "info" | "warn" | "error";

export interface ToastProps {
  level: ToastLevel;
  text: string;
  durationMs?: number;
  onDismiss?: () => void;
  theme?: Theme;
}

const DEFAULT_DURATION_MS = 4000;

function pickBorderColor(level: ToastLevel, theme: Theme): string {
  switch (level) {
    case "error":
      return theme.haltCardBorder; // red-ish
    case "warn":
      return theme.planBorder; // amber-ish
    default:
      return theme.accent; // blue
  }
}

function pickTextColor(level: ToastLevel, theme: Theme): string {
  switch (level) {
    case "error":
      return theme.haltCardTitle;
    case "warn":
      return theme.planTitle;
    default:
      return theme.text;
  }
}

export function Toast({ level, text, durationMs, onDismiss, theme }: ToastProps): React.ReactNode {
  const ms = durationMs ?? DEFAULT_DURATION_MS;

  useEffect(() => {
    if (!onDismiss) return;
    const id = setTimeout(() => {
      try {
        onDismiss();
      } catch {
        /* swallow — toast dismissal must never crash the host */
      }
    }, ms);
    return () => clearTimeout(id);
  }, [ms, onDismiss]);

  // Fallback theme in case caller didn't pass one (keeps the component usable
  // from non-themed sites). Mirrors the dark theme defaults.
  const t: Theme =
    theme ??
    ({
      border: "#333333",
      text: "#e0e0e0",
      accent: "#5c9cf5",
      haltCardBorder: "#c0392b",
      haltCardTitle: "#e74c3c",
      planBorder: "#e5c07b",
      planTitle: "#e5c07b",
    } as unknown as Theme);

  const borderColor = pickBorderColor(level, t);
  const fg = pickTextColor(level, t);

  return (
    // biome-ignore lint/a11y/useValidAriaRole: "toast" is a valid Role in our extended protocol (packages/agent-harness-core/src/protocol.ts), not strict ARIA
    <Semantic id="toast" role="toast" name={text}>
      <box
        flexDirection="row"
        borderStyle="single"
        borderColor={borderColor}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <text fg={fg}>{text}</text>
      </box>
    </Semantic>
  );
}
