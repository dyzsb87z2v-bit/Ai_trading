/**
 * Indicator engine public surface (master spec §5).
 *
 * `computeIndicatorSet` runs the standard battery over one candle series and
 * returns both full series (for charting) and latest readings (for scoring).
 */

export * from "./types";
export * from "./movingAverages";
export * from "./oscillators";
export * from "./volatility";
export * from "./volume";
export * from "./fibonacci";

import type { Candle } from "../types";
import { ema, sma } from "./movingAverages";
import { cci, macd, roc, rsi, stochastic } from "./oscillators";
import { adx, atr, bollingerBands } from "./volatility";
import { obv, relativeVolume, vwap } from "./volume";
import { clamp01, type IndicatorReading, type IndicatorSignal } from "./types";

export interface IndicatorSetOptions {
  emaFast?: number;
  emaSlow?: number;
  emaTrend?: number;
  rsiPeriod?: number;
  atrPeriod?: number;
  adxPeriod?: number;
  bollingerPeriod?: number;
  volumePeriod?: number;
}

const DEFAULTS: Required<IndicatorSetOptions> = {
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 200,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  bollingerPeriod: 20,
  volumePeriod: 20,
};

export interface IndicatorSet {
  closes: number[];
  ema20: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  sma20: (number | null)[];
  rsi: (number | null)[];
  macd: ReturnType<typeof macd>;
  bollinger: ReturnType<typeof bollingerBands>;
  atr: (number | null)[];
  adx: ReturnType<typeof adx>;
  stochastic: ReturnType<typeof stochastic>;
  cci: (number | null)[];
  roc: (number | null)[];
  obv: number[];
  vwap: (number | null)[];
  relativeVolume: (number | null)[];
}

export function computeIndicatorSet(
  candles: readonly Candle[],
  options: IndicatorSetOptions = {}
): IndicatorSet {
  const o = { ...DEFAULTS, ...options };
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  return {
    closes,
    ema20: ema(closes, o.emaFast),
    ema50: ema(closes, o.emaSlow),
    ema200: ema(closes, o.emaTrend),
    sma20: sma(closes, o.emaFast),
    rsi: rsi(closes, o.rsiPeriod),
    macd: macd(closes),
    bollinger: bollingerBands(closes, o.bollingerPeriod),
    atr: atr(highs, lows, closes, o.atrPeriod),
    adx: adx(highs, lows, closes, o.adxPeriod),
    stochastic: stochastic(highs, lows, closes),
    cci: cci(highs, lows, closes),
    roc: roc(closes),
    obv: obv(closes, volumes),
    vwap: vwap(candles),
    relativeVolume: relativeVolume(volumes, o.volumePeriod),
  };
}

/** Last non-null element of a series, or null when the series never resolved. */
export function latest<T>(series: readonly (T | null)[]): T | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Build the §5-mandated reading (value, timestamp, params, signal, strength). */
export function toReading(
  id: string,
  series: readonly (number | null)[],
  candles: readonly Candle[],
  parameters: Readonly<Record<string, number | string>>,
  interpret: (value: number) => { signal: IndicatorSignal; strength: number }
): IndicatorReading {
  const index = lastDefinedIndex(series);
  if (index < 0) {
    return {
      id,
      value: null,
      timestamp: candles.length > 0 ? candles[candles.length - 1].timestamp : 0,
      parameters,
      signal: "neutral",
      strength: 0,
    };
  }
  const value = series[index] as number;
  const { signal, strength } = interpret(value);
  return {
    id,
    value,
    timestamp: candles[index]?.timestamp ?? 0,
    parameters,
    signal,
    strength: clamp01(strength),
  };
}

export function lastDefinedIndex(series: readonly (number | null)[]): number {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return i;
  }
  return -1;
}
