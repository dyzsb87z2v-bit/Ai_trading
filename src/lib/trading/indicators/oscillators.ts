/**
 * Oscillators (master spec §5): RSI, Stochastic, CCI, ROC, MACD.
 *
 * RSI and MACD are the two indicators most often implemented subtly wrong, so
 * both follow the canonical definitions exactly: RSI uses Wilder smoothing (not
 * a plain EMA), and MACD's signal line is an EMA of the MACD line computed only
 * over bars where the MACD line exists.
 */

import { assertPeriod, ema, sma, wilderSmooth } from "./movingAverages";

/**
 * Wilder's RSI. Returns values in [0, 100]; null during warm-up.
 *
 * A period of all-gains yields exactly 100 (avgLoss === 0), which is correct —
 * not a divide-by-zero to be patched with an epsilon.
 */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  const gains: number[] = new Array(closes.length).fill(0);
  const losses: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // Drop index 0 (no prior close, so no change) before smoothing.
  const avgGain = wilderSmooth(gains.slice(1), period);
  const avgLoss = wilderSmooth(losses.slice(1), period);

  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || l === null) continue;
    // +1 realigns to the original array (we sliced one element off the front).
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/**
 * MACD. The signal line is an EMA of the MACD line seeded from the first bar
 * where the MACD line is defined — seeding it from index 0 (with nulls coerced
 * to 0) is the classic bug that shifts every crossover.
 */
export function macd(
  closes: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdResult {
  assertPeriod(fastPeriod);
  assertPeriod(slowPeriod);
  assertPeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new RangeError("MACD fast period must be shorter than the slow period");
  }

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return f === null || s === null ? null : f - s;
  });

  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signalLine: (number | null)[] = new Array(closes.length).fill(null);
  const histogram: (number | null)[] = new Array(closes.length).fill(null);

  if (firstDefined >= 0) {
    const dense = macdLine.slice(firstDefined) as number[];
    const signalDense = ema(dense, signalPeriod);
    for (let i = 0; i < signalDense.length; i++) {
      const value = signalDense[i];
      if (value === null) continue;
      const target = firstDefined + i;
      signalLine[target] = value;
      const line = macdLine[target];
      if (line !== null) histogram[target] = line - value;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

/**
 * Stochastic oscillator. %K is the raw stochastic smoothed over `kSmoothing`
 * bars (kSmoothing = 1 gives the "fast" stochastic); %D is the SMA of %K.
 *
 * A flat window (high === low) yields 50 — the neutral reading — rather than a
 * division by zero.
 */
export function stochastic(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 14,
  kSmoothing = 3,
  dPeriod = 3
): StochasticResult {
  assertPeriod(period);
  assertPeriod(kSmoothing);
  assertPeriod(dPeriod);
  assertEqualLengths(highs, lows, closes);

  const raw: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > highest) highest = highs[j];
      if (lows[j] < lowest) lowest = lows[j];
    }
    const range = highest - lowest;
    raw[i] = range === 0 ? 50 : ((closes[i] - lowest) / range) * 100;
  }

  const k = smoothNullable(raw, kSmoothing);
  const d = smoothNullable(k, dPeriod);
  return { k, d };
}

/**
 * Commodity Channel Index using mean absolute deviation (Lambert's original),
 * not standard deviation — the two differ by roughly 20% and only the former
 * makes the ±100 thresholds meaningful.
 */
export function cci(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 20
): (number | null)[] {
  assertPeriod(period);
  assertEqualLengths(highs, lows, closes);

  const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const avg = sma(typical, period);
  const out: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const mean = avg[i];
    if (mean === null) continue;
    let deviation = 0;
    for (let j = i - period + 1; j <= i; j++) deviation += Math.abs(typical[j] - mean);
    const meanDeviation = deviation / period;
    out[i] = meanDeviation === 0 ? 0 : (typical[i] - mean) / (0.015 * meanDeviation);
  }
  return out;
}

/** Rate of change, in percent, over `period` bars. */
export function roc(values: readonly number[], period = 12): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const base = values[i - period];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** SMA over a nullable series, preserving null alignment. */
function smoothNullable(values: readonly (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period === 1) return values.slice();
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let complete = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        complete = false;
        break;
      }
      sum += v;
    }
    if (complete) out[i] = sum / period;
  }
  return out;
}

export function assertEqualLengths(...series: readonly (readonly number[])[]): void {
  const [first, ...rest] = series;
  for (const other of rest) {
    if (other.length !== first.length) {
      throw new RangeError("Indicator inputs must be index-aligned series of equal length");
    }
  }
}
