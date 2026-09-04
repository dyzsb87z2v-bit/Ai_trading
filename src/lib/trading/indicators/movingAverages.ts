/**
 * Moving averages (master spec §5): SMA, EMA, WMA.
 *
 * All three run in O(n) and operate on full-precision inputs — never on values
 * that have been rounded for display (§5).
 */

/**
 * Simple moving average. Uses a running sum, but re-seeds every `period` bars so
 * floating-point drift cannot accumulate across a long series.
 */
export function sma(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period > values.length) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) {
      // Re-seed periodically: a running sum over thousands of bars drifts.
      if (i % 1000 === 0) {
        sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
      }
      out[i] = sum / period;
    }
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values —
 * the convention used by Wilder-derived indicators and by every charting package
 * this is expected to agree with.
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period > values.length) return out;

  const multiplier = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * multiplier + prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (the "RMA"/"SMMA" used inside RSI, ATR and ADX).
 * Equivalent to an EMA with multiplier 1/period, seeded on the simple average.
 * Kept separate from `ema` because conflating the two is the single most common
 * source of RSI/ATR values that disagree with every other platform.
 */
export function wilderSmooth(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period > values.length) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Linearly weighted moving average — newest bar carries weight `period`. */
export function wma(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period > values.length) return out;

  const denominator = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let weighted = 0;
    for (let k = 0; k < period; k++) {
      weighted += values[i - period + 1 + k] * (k + 1);
    }
    out[i] = weighted / denominator;
  }
  return out;
}

export function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`Indicator period must be a positive integer, received ${period}`);
  }
}
