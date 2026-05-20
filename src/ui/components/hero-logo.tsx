import { useEffect, useRef, useState } from "react";
import { HERO_ROWS, STAR_PALETTE } from "../constants.js";
import type { Theme } from "../theme.js";

export function HeroLogo({ t }: { t: Theme }) {
  const [tick, setTick] = useState(0);
  const starIdx = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 900);
    return () => clearInterval(id);
  }, []);

  starIdx.current = 0;
  const nextColor = () => {
    const i = starIdx.current++;
    return STAR_PALETTE[(i * 7 + tick * 3 + i * tick) % STAR_PALETTE.length];
  };

  return (
    <box flexDirection="column" alignItems="center">
      {HERO_ROWS.map((row, r) => {
        const els: import("react").ReactNode[] = [];
        let cursor = 0;

        for (const star of row.stars) {
          if (row.brand !== undefined && cursor <= row.brand && star.col > row.brand) {
            els.push(" ".repeat(row.brand - cursor));
            els.push(
              <span key="brand" style={{ fg: t.primary }}>
                {"muonroi"}
              </span>,
            );
            cursor = row.brand + 7;
          }
          const gap = star.col - cursor;
          if (gap > 0) els.push(" ".repeat(gap));
          els.push(
            <span key={`s-${star.col}`} style={{ fg: nextColor() }}>
              {star.ch}
            </span>,
          );
          cursor = star.col + 1;
        }

        if (row.brand !== undefined && cursor <= row.brand) {
          els.push(" ".repeat(row.brand - cursor));
          els.push(
            <span key="brand" style={{ fg: t.primary }}>
              {"muonroi"}
            </span>,
          );
          cursor = row.brand + 7;
        }

        els.push(" ".repeat(Math.max(0, 35 - cursor)));
        // biome-ignore lint/suspicious/noArrayIndexKey: static constant array that never reorders
        return <text key={r}>{els}</text>;
      })}
    </box>
  );
}
