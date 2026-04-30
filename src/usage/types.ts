/**
 * src/usage/types.ts
 *
 * Core types for the reservation ledger and threshold system.
 * USAGE-02 (thresholds) + USAGE-03 (reservation ledger).
 */

export interface ReservationToken {
  id: string;
  model: string;
  provider: string;
  projected_usd: number;
  est_input_tokens: number;
  est_output_tokens: number;
  createdAtMs: number;
}

export class CapBreachError extends Error {
  constructor(
    public readonly current: number,
    public readonly reserved: number,
    public readonly projected: number,
    public readonly cap: number,
  ) {
    super(
      `Cap breach: current=${current.toFixed(4)} reserved=${reserved.toFixed(4)} projected=${projected.toFixed(4)} cap=${cap.toFixed(4)}`,
    );
    this.name = "CapBreachError";
  }
}

export type ThresholdLevel = 50 | 80 | 100;

export interface ThresholdEvent {
  level: ThresholdLevel;
  current_pct: number;
  current_usd: number;
  cap_usd: number;
  atMs: number;
}
