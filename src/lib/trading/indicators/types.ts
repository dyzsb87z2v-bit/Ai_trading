/**
 * Indicator engine types (master spec §5).
 *
 * Every indicator exposes value, timestamp, parameters, signal and strength.
 * Series are index-aligned with the input candles: element i corresponds to
 * candle i, and `null` marks a bar where the indicator is not yet defined
 * (warm-up). Nulls are never replaced by zeros — a zero RSI means something.
 */

export type IndicatorSignal = "bullish" | "bearish" | "neutral";

export interface IndicatorPoint {
  timestamp: number;
  value: number | null;
}

/** Latest reading of an indicator, with everything needed to explain it. */
export interface IndicatorReading {
  id: string;
  value: number | null;
  timestamp: number;
  parameters: Readonly<Record<string, number | string>>;
  signal: IndicatorSignal;
  /** Conviction in [0,1]. 0 when the indicator has nothing to say. */
  strength: number;
}

export interface IndicatorSeries {
  id: string;
  parameters: Readonly<Record<string, number | string>>;
  points: readonly IndicatorPoint[];
}

/** Clamp helper shared by strength calculations. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamp to [-1, 1] — the normalised directional range used by ScoreFactor. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}
