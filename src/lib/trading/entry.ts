/**
 * Entry engine (master spec §10, §37).
 *
 * Derives entry zone, invalidation, stop and targets from market structure and
 * volatility — never from a fixed percentage. A stop must sit where the trade
 * idea is WRONG, which is a structural question; "2% below entry" answers a
 * different question and is the reason so many stops get hit for no reason.
 */

import type { MarketStructure, PriceLevel } from "./structure";
import type { Candle, Side } from "./types";
import { riskRewardRatio } from "./positionSizing";
import { latest } from "./indicators";
import { atr } from "./indicators/volatility";

export interface TradePlanLevels {
  side: Side;
  entryZoneLow: number;
  entryZoneHigh: number;
  preferredEntry: number;
  /** Price at which the setup's premise is void. */
  invalidation: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  /** Per-unit risk and reward to TP1 (the target used for the R:R gate). */
  riskPerUnit: number;
  rewardPerUnit: number;
  riskReward: number | null;
  /** R:R measured to the furthest target. */
  riskRewardToFinalTarget: number | null;
  rationale: string[];
}

export interface EntryEngineOptions {
  /**
   * Price the plan is built around. Defaults to the last bar's close, but a
   * live quote is more recent and MUST be used when one exists — otherwise the
   * stop is measured from a stale reference and can end up on the wrong side of
   * the price the position is actually sized at.
   */
  referencePrice?: number;
  atrPeriod?: number;
  /** ATR multiple placing the stop beyond the structural level. */
  stopAtrBuffer?: number;
  /** Half-width of the entry zone, in ATR. */
  entryZoneAtr?: number;
  /** R-multiples for the three targets when no structural level is nearer. */
  targetRMultiples?: [number, number, number];
}

// referencePrice is excluded: it has no static default — it comes from the
// live quote, or falls back to the last bar's close at call time.
const DEFAULTS: Required<Omit<EntryEngineOptions, "referencePrice">> = {
  atrPeriod: 14,
  // A buffer beyond the level, so ordinary noise around it does not stop us out.
  stopAtrBuffer: 0.5,
  entryZoneAtr: 0.25,
  targetRMultiples: [1.5, 2.5, 4],
};

/**
 * Build the levels for a setup.
 *
 * Stop placement: below the nearest swing low (long) or above the nearest swing
 * high (short), plus an ATR buffer. Targets prefer real structure — the next
 * resistance above (long) — and fall back to R-multiples when no level is in
 * range, because inventing a level would be fabricating structure that is not
 * in the data.
 *
 * Returns null when the data cannot support a coherent plan; that is a valid
 * outcome (§35), not a failure to paper over.
 */
export function buildTradePlanLevels(
  candles: readonly Candle[],
  structure: MarketStructure,
  side: Side,
  options: EntryEngineOptions = {}
): TradePlanLevels | null {
  const o = { ...DEFAULTS, ...options };
  if (candles.length < o.atrPeriod + 2) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const atrValue = latest(atr(highs, lows, closes, o.atrPeriod));
  if (atrValue === null || atrValue <= 0) return null;

  const referencePrice = options.referencePrice;
  const price =
    referencePrice !== undefined && Number.isFinite(referencePrice) && referencePrice > 0
      ? referencePrice
      : closes[closes.length - 1];
  const rationale: string[] = [];

  const structuralStop = findStructuralStop(structure, side, price);
  if (structuralStop === null) {
    rationale.push("No swing level available for a structural stop; using an ATR-based stop.");
  }

  const buffer = atrValue * o.stopAtrBuffer;
  const stopLoss =
    side === "long"
      ? (structuralStop ?? price - atrValue * 2) - buffer
      : (structuralStop ?? price + atrValue * 2) + buffer;

  // The invalidation is the level itself; the stop sits beyond it so that
  // touching the level is not the same as being wrong.
  const invalidation = structuralStop ?? stopLoss;

  if (structuralStop !== null) {
    rationale.push(
      `Stop placed ${o.stopAtrBuffer} ATR (${buffer.toFixed(4)}) beyond the ${
        side === "long" ? "swing low" : "swing high"
      } at ${structuralStop.toFixed(4)}.`
    );
  }

  const riskPerUnit = Math.abs(price - stopLoss);
  if (riskPerUnit <= 0) return null;

  const zoneHalfWidth = atrValue * o.entryZoneAtr;
  const entryZoneLow = price - zoneHalfWidth;
  const entryZoneHigh = price + zoneHalfWidth;
  rationale.push(
    `Entry zone ${entryZoneLow.toFixed(4)}–${entryZoneHigh.toFixed(4)} (±${o.entryZoneAtr} ATR around ${price.toFixed(4)}).`
  );

  const structuralTargets = findStructuralTargets(structure, side, price);
  const targets = buildTargets(price, riskPerUnit, side, structuralTargets, o.targetRMultiples);

  if (structuralTargets.length > 0) {
    rationale.push(
      `Targets anchored on ${structuralTargets.length} structural level(s): ${structuralTargets
        .slice(0, 3)
        .map((t) => t.toFixed(4))
        .join(", ")}.`
    );
  } else {
    rationale.push(
      `No structural level in range; targets projected at ${o.targetRMultiples.join("R, ")}R.`
    );
  }

  const rewardPerUnit = Math.abs(targets[0] - price);

  return {
    side,
    entryZoneLow,
    entryZoneHigh,
    preferredEntry: price,
    invalidation,
    stopLoss,
    takeProfit1: targets[0],
    takeProfit2: targets[1],
    takeProfit3: targets[2],
    riskPerUnit,
    rewardPerUnit,
    riskReward: riskRewardRatio(price, stopLoss, targets[0]),
    riskRewardToFinalTarget: riskRewardRatio(price, stopLoss, targets[2]),
    rationale,
  };
}

/** Nearest protective swing level on the correct side of price. */
function findStructuralStop(structure: MarketStructure, side: Side, price: number): number | null {
  const candidates =
    side === "long"
      ? structure.support.filter((l) => l.price < price)
      : structure.resistance.filter((l) => l.price > price);
  if (candidates.length === 0) return null;
  // Nearest level, so the stop is as tight as the structure honestly allows.
  return candidates.reduce((closest: PriceLevel, level: PriceLevel) =>
    Math.abs(level.price - price) < Math.abs(closest.price - price) ? level : closest
  ).price;
}

/** Structural levels ahead of price, ordered by distance. */
function findStructuralTargets(structure: MarketStructure, side: Side, price: number): number[] {
  const levels =
    side === "long"
      ? structure.resistance.filter((l) => l.price > price)
      : structure.support.filter((l) => l.price < price);
  return levels.map((l) => l.price).sort((a, b) => Math.abs(a - price) - Math.abs(b - price));
}

/**
 * Blend structural targets with R-multiple fallbacks.
 *
 * A structural target is only used when it is at least as far as 1R — a
 * resistance level sitting inside the stop distance is not a target, it is a
 * reason not to take the trade.
 */
function buildTargets(
  price: number,
  riskPerUnit: number,
  side: Side,
  structural: readonly number[],
  rMultiples: readonly [number, number, number]
): [number, number, number] {
  const direction = side === "long" ? 1 : -1;
  const usable = structural.filter((t) => Math.abs(t - price) >= riskPerUnit);
  const out: number[] = [];

  for (let i = 0; i < 3; i++) {
    const fallback = price + direction * riskPerUnit * rMultiples[i];
    const candidate = usable[i];
    if (candidate === undefined) {
      out.push(fallback);
      continue;
    }
    // Keep targets strictly increasing in distance.
    const previous = out[i - 1];
    if (previous !== undefined && Math.abs(candidate - price) <= Math.abs(previous - price)) {
      out.push(fallback);
    } else {
      out.push(candidate);
    }
  }
  return [out[0], out[1], out[2]];
}
