/**
 * SIMULATED market data generator (master spec §32).
 *
 * ⚠️  THIS IS NOT MARKET DATA. Every candle and quote produced here is
 *     synthetic and is stamped `status: "SIMULATED"`. It exists so the terminal
 *     interface can be exercised before a real provider adapter is configured.
 *
 * Because `SIMULATED` is not in `TRADEABLE_DATA_STATUSES`, the freshness gate
 * refuses live analysis on this data and the risk engine can never return a
 * tradeable verdict from it. That is deliberate: the demo mode demonstrates the
 * safety property rather than bypassing it.
 *
 * The generator is seeded and deterministic, so the same symbol always produces
 * the same series — a moving demo would make the UI impossible to reason about.
 */

import { TIMEFRAME_MS, type Candle, type Instrument, type Quote, type Timeframe } from "./types";

/**
 * Mulberry32 — a small, fast, deterministic PRNG. Chosen over Math.random so a
 * given symbol renders identically on every reload and across server restarts.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromSymbol(symbol: string): number {
  let hash = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    hash ^= symbol.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Box–Muller transform: uniform PRNG output to a standard normal draw. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimulatedSeriesOptions {
  symbol: string;
  timeframe: Timeframe;
  count: number;
  /** Anchor for the last bar. Defaults to now. */
  endTime?: number;
  basePrice?: number;
}

/**
 * Generate a synthetic OHLCV series.
 *
 * The price path is a random walk with a mild mean-reverting drift and
 * volatility clustering, which produces the swings, ranges and pullbacks the
 * structure engine needs to have anything to analyse. A pure random walk tends
 * to drift monotonically and leaves the structure engine with no swing points.
 */
export function generateSimulatedCandles(options: SimulatedSeriesOptions): Candle[] {
  const { symbol, timeframe, count } = options;
  const step = TIMEFRAME_MS[timeframe];
  const endTime = options.endTime ?? Date.now();
  const random = mulberry32(seedFromSymbol(`${symbol}:${timeframe}`));

  const basePrice = options.basePrice ?? 40 + (seedFromSymbol(symbol) % 400);
  const candles: Candle[] = [];

  let price = basePrice;
  let volatility = basePrice * 0.008;
  let trend = 0;

  // Align the newest bar to its own timeframe boundary so timestamps look like
  // real bar opens rather than an arbitrary offset.
  const lastOpen = Math.floor(endTime / step) * step;

  for (let i = 0; i < count; i++) {
    // Volatility clustering: today's volatility remembers yesterday's.
    volatility = Math.max(
      basePrice * 0.002,
      volatility * 0.94 + Math.abs(gaussian(random)) * basePrice * 0.0006
    );
    // Slowly varying drift creates trends and ranges instead of pure noise.
    trend = trend * 0.97 + gaussian(random) * 0.0004;
    // Mean reversion keeps the series near its base rather than wandering off.
    const reversion = (basePrice - price) * 0.002;

    const open = price;
    const change = price * trend + reversion + gaussian(random) * volatility;
    const close = Math.max(0.01, open + change);

    const wick = Math.abs(gaussian(random)) * volatility * 0.8;
    const high = Math.max(open, close) + wick;
    const low = Math.max(0.01, Math.min(open, close) - wick);

    // Volume rises with the size of the move — quiet bars trade less.
    const moveRatio = Math.abs(close - open) / Math.max(volatility, 1e-9);
    const volume = Math.round(500_000 * (0.6 + moveRatio * 0.5 + random() * 0.4));

    candles.push({
      timestamp: lastOpen - (count - 1 - i) * step,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }

  return candles;
}

/** A synthetic quote consistent with the last candle of a simulated series. */
export function generateSimulatedQuote(
  instrument: Instrument,
  candles: readonly Candle[]
): Quote | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const previous = candles.length > 1 ? candles[candles.length - 2] : last;
  const spread = Math.max(0.01, last.close * 0.0002);

  return {
    instrument,
    last: last.close,
    bid: last.close - spread / 2,
    ask: last.close + spread / 2,
    spread,
    volume: last.volume,
    tradeCount: Math.round(last.volume / 120),
    vwap: (last.high + last.low + last.close) / 3,
    changePercent:
      previous.close === 0 ? 0 : ((last.close - previous.close) / previous.close) * 100,
    session: "regular",
    provenance: {
      // Named so it is unmistakable in any log, response body or UI element.
      source: "simulated-generator",
      timestamp: last.timestamp,
      status: "SIMULATED",
    },
  };
}

/** The banner text the UI must display whenever this data is on screen. */
export const SIMULATED_DATA_NOTICE =
  "SIMULATED DATA — synthetic series for interface demonstration only. " +
  "This is not market data. Live analysis and trading are disabled.";
