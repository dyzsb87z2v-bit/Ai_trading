/**
 * Volatility and trend-strength indicators (master spec §5):
 * ATR, Bollinger Bands, ADX/DI, realised volatility.
 */

import { assertPeriod, sma, wilderSmooth } from "./movingAverages";
import { assertEqualLengths } from "./oscillators";

/**
 * True Range. Bar 0 has no previous close, so its TR is high − low.
 */
export function trueRange(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[]
): number[] {
  assertEqualLengths(highs, lows, closes);
  const out: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      out[i] = highs[i] - lows[i];
      continue;
    }
    const prevClose = closes[i - 1];
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
  }
  return out;
}

/** Wilder's Average True Range. */
export function atr(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 14
): (number | null)[] {
  assertPeriod(period);
  return wilderSmooth(trueRange(highs, lows, closes), period);
}

export interface BollingerResult {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  /** (upper − lower) / middle — the standard bandwidth, used for squeezes. */
  bandwidth: (number | null)[];
  /** Where price sits inside the bands: 0 = lower band, 1 = upper band. */
  percentB: (number | null)[];
}

/**
 * Bollinger Bands. Uses the POPULATION standard deviation (divide by N), which
 * is what Bollinger specified and what charting platforms draw; the sample
 * deviation (N−1) produces visibly wider bands.
 */
export function bollingerBands(
  closes: readonly number[],
  period = 20,
  stdDevMultiplier = 2
): BollingerResult {
  assertPeriod(period);
  const middle = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  const bandwidth: (number | null)[] = new Array(closes.length).fill(null);
  const percentB: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i];
    if (mean === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - mean;
      variance += diff * diff;
    }
    const sd = Math.sqrt(variance / period);
    const up = mean + stdDevMultiplier * sd;
    const low = mean - stdDevMultiplier * sd;
    upper[i] = up;
    lower[i] = low;
    bandwidth[i] = mean === 0 ? null : (up - low) / mean;
    percentB[i] = up === low ? 0.5 : (closes[i] - low) / (up - low);
  }
  return { middle, upper, lower, bandwidth, percentB };
}

export interface AdxResult {
  adx: (number | null)[];
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

/**
 * Wilder's ADX with +DI / −DI.
 *
 * Directional movement is exclusive: on a bar where both moves are positive
 * only the larger counts, and equal moves count as neither. ADX itself is the
 * Wilder-smoothed DX, so it needs roughly 2 × period bars to become defined.
 */
export function adx(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 14
): AdxResult {
  assertPeriod(period);
  assertEqualLengths(highs, lows, closes);

  const length = closes.length;
  const empty = (): (number | null)[] => new Array(length).fill(null);
  if (length < 2) return { adx: empty(), plusDi: empty(), minusDi: empty() };

  const tr = trueRange(highs, lows, closes);
  const plusDm: number[] = new Array(length).fill(0);
  const minusDm: number[] = new Array(length).fill(0);

  for (let i = 1; i < length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Index 0 carries no directional information; smooth from index 1 onward.
  const smoothedTr = wilderSmooth(tr.slice(1), period);
  const smoothedPlus = wilderSmooth(plusDm.slice(1), period);
  const smoothedMinus = wilderSmooth(minusDm.slice(1), period);

  const plusDi = empty();
  const minusDi = empty();
  const dx: (number | null)[] = [];

  for (let i = 0; i < smoothedTr.length; i++) {
    const t = smoothedTr[i];
    const p = smoothedPlus[i];
    const m = smoothedMinus[i];
    if (t === null || p === null || m === null || t === 0) {
      dx.push(null);
      continue;
    }
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    plusDi[i + 1] = pdi;
    minusDi[i + 1] = mdi;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  const adxOut = empty();
  const firstDx = dx.findIndex((v) => v !== null);
  if (firstDx >= 0) {
    const dense = dx.slice(firstDx).filter((v): v is number => v !== null);
    const smoothedDx = wilderSmooth(dense, period);
    for (let i = 0; i < smoothedDx.length; i++) {
      const value = smoothedDx[i];
      if (value !== null) adxOut[firstDx + i + 1] = value;
    }
  }

  return { adx: adxOut, plusDi, minusDi };
}

/**
 * Annualised realised volatility from log returns, as a fraction (0.35 = 35%).
 * `barsPerYear` must match the series timeframe — passing a daily count for an
 * intraday series is the usual way this number becomes nonsense.
 */
export function realizedVolatility(
  closes: readonly number[],
  period: number,
  barsPerYear: number
): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const returns: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0 || closes[i] <= 0) continue;
    returns[i] = Math.log(closes[i] / closes[i - 1]);
  }

  for (let i = period; i < closes.length; i++) {
    const window: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      const r = returns[j];
      if (r === null) break;
      window.push(r);
    }
    if (window.length < period) continue;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    // Sample deviation (N−1): these returns are a sample of the process.
    const variance =
      window.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (window.length - 1);
    out[i] = Math.sqrt(variance) * Math.sqrt(barsPerYear);
  }
  return out;
}
