/**
 * Volume-based analysis (master spec §5): OBV, VWAP, Volume Profile.
 */

import type { Candle } from "../types";
import { assertPeriod, sma } from "./movingAverages";

/**
 * On-Balance Volume. Starts at 0 on the first bar; an unchanged close adds
 * nothing (Granville's rule), it does not carry the previous direction.
 */
export function obv(closes: readonly number[], volumes: readonly number[]): number[] {
  if (closes.length !== volumes.length) {
    throw new RangeError("OBV requires index-aligned close and volume series");
  }
  const out: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const prior = out[i - 1];
    if (closes[i] > closes[i - 1]) out[i] = prior + volumes[i];
    else if (closes[i] < closes[i - 1]) out[i] = prior - volumes[i];
    else out[i] = prior;
  }
  return out;
}

/**
 * Session-anchored VWAP: Σ(typical price × volume) / Σ(volume), reset whenever
 * `isSessionStart` reports a new session.
 *
 * VWAP is meaningless without an anchor — a running total from the first bar in
 * the database is not the VWAP any trader is looking at. The default anchor is
 * the UTC day boundary; pass your own for exchange sessions.
 */
export function vwap(
  candles: readonly Candle[],
  isSessionStart: (candle: Candle, previous: Candle | null) => boolean = utcDayBoundary
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let cumulativePv = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const previous = i === 0 ? null : candles[i - 1];
    if (isSessionStart(candle, previous)) {
      cumulativePv = 0;
      cumulativeVolume = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePv += typical * candle.volume;
    cumulativeVolume += candle.volume;
    out[i] = cumulativeVolume === 0 ? null : cumulativePv / cumulativeVolume;
  }
  return out;
}

export function utcDayBoundary(candle: Candle, previous: Candle | null): boolean {
  if (previous === null) return true;
  const day = 86_400_000;
  return Math.floor(candle.timestamp / day) !== Math.floor(previous.timestamp / day);
}

export interface VolumeProfileBin {
  priceLow: number;
  priceHigh: number;
  volume: number;
}

export interface VolumeProfile {
  bins: readonly VolumeProfileBin[];
  /** Price level with the highest traded volume (Point of Control). */
  pointOfControl: number;
  /** Bounds of the value area — the band holding `valueAreaPercent` of volume. */
  valueAreaHigh: number;
  valueAreaLow: number;
  totalVolume: number;
}

/**
 * Volume profile over a candle window.
 *
 * Each bar's volume is spread UNIFORMLY across the price bins its range covers,
 * proportional to the overlap. Dumping a bar's whole volume into its close bin
 * is cheaper but produces a profile that misrepresents where trade occurred.
 *
 * The value area grows outward from the POC, taking the heavier neighbour at
 * each step, until the requested share of volume is enclosed — the standard
 * Market Profile construction.
 */
export function volumeProfile(
  candles: readonly Candle[],
  binCount = 24,
  valueAreaPercent = 0.7
): VolumeProfile | null {
  if (candles.length === 0 || binCount < 1) return null;

  let low = Infinity;
  let high = -Infinity;
  for (const c of candles) {
    if (c.low < low) low = c.low;
    if (c.high > high) high = c.high;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

  // A window with no range at all still has a valid, single-price profile.
  if (high === low) {
    const total = candles.reduce((acc, c) => acc + c.volume, 0);
    return {
      bins: [{ priceLow: low, priceHigh: high, volume: total }],
      pointOfControl: low,
      valueAreaHigh: high,
      valueAreaLow: low,
      totalVolume: total,
    };
  }

  const binSize = (high - low) / binCount;
  const volumes: number[] = new Array(binCount).fill(0);

  for (const candle of candles) {
    const range = candle.high - candle.low;
    if (range === 0) {
      const index = Math.min(binCount - 1, Math.floor((candle.low - low) / binSize));
      volumes[index] += candle.volume;
      continue;
    }
    const firstBin = Math.min(binCount - 1, Math.floor((candle.low - low) / binSize));
    const lastBin = Math.min(binCount - 1, Math.floor((candle.high - low) / binSize));
    for (let b = firstBin; b <= lastBin; b++) {
      const binLow = low + b * binSize;
      const binHigh = binLow + binSize;
      const overlap = Math.min(candle.high, binHigh) - Math.max(candle.low, binLow);
      if (overlap > 0) volumes[b] += candle.volume * (overlap / range);
    }
  }

  const bins: VolumeProfileBin[] = volumes.map((volume, b) => ({
    priceLow: low + b * binSize,
    priceHigh: low + (b + 1) * binSize,
    volume,
  }));

  let pocIndex = 0;
  for (let b = 1; b < bins.length; b++) {
    if (bins[b].volume > bins[pocIndex].volume) pocIndex = b;
  }

  const totalVolume = volumes.reduce((a, b) => a + b, 0);
  const target = totalVolume * valueAreaPercent;
  let lowerIndex = pocIndex;
  let upperIndex = pocIndex;
  let accumulated = bins[pocIndex].volume;

  while (accumulated < target && (lowerIndex > 0 || upperIndex < bins.length - 1)) {
    const below = lowerIndex > 0 ? bins[lowerIndex - 1].volume : -1;
    const above = upperIndex < bins.length - 1 ? bins[upperIndex + 1].volume : -1;
    if (above >= below) {
      upperIndex++;
      accumulated += bins[upperIndex].volume;
    } else {
      lowerIndex--;
      accumulated += bins[lowerIndex].volume;
    }
  }

  return {
    bins,
    pointOfControl: (bins[pocIndex].priceLow + bins[pocIndex].priceHigh) / 2,
    valueAreaHigh: bins[upperIndex].priceHigh,
    valueAreaLow: bins[lowerIndex].priceLow,
    totalVolume,
  };
}

/**
 * Relative volume: current bar's volume as a multiple of the average of the
 * PRECEDING `period` bars. The current bar is excluded from its own baseline,
 * otherwise a genuine spike partly cancels itself out.
 */
export function relativeVolume(volumes: readonly number[], period = 20): (number | null)[] {
  assertPeriod(period);
  const averages = sma(volumes, period);
  const out: (number | null)[] = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    const baseline = averages[i - 1];
    if (baseline === null || baseline === 0) continue;
    out[i] = volumes[i] / baseline;
  }
  return out;
}
