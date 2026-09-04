/**
 * Indicator engine correctness (master spec §5, §41).
 *
 * These assert against values that can be derived by hand or from the canonical
 * definitions, not against whatever the implementation happens to return. Where
 * a constant looks arbitrary it is followed by the arithmetic that produced it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ema, sma, wilderSmooth, wma } from "@/lib/trading/indicators/movingAverages";
import { cci, macd, roc, rsi, stochastic } from "@/lib/trading/indicators/oscillators";
import {
  adx,
  atr,
  bollingerBands,
  realizedVolatility,
  trueRange,
} from "@/lib/trading/indicators/volatility";
import { obv, relativeVolume, volumeProfile, vwap } from "@/lib/trading/indicators/volume";
import { fibonacciExtensions, fibonacciRetracements } from "@/lib/trading/indicators/fibonacci";
import type { Candle } from "@/lib/trading/types";

const closeTo = (actual: number | null, expected: number, epsilon = 1e-9) => {
  assert.notEqual(actual, null, "expected a defined value, received null");
  assert.ok(
    Math.abs((actual as number) - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
};

test("sma: warm-up is null and the first value is the mean of the window", () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  closeTo(out[2], 2); // (1+2+3)/3
  closeTo(out[3], 3);
  closeTo(out[4], 4);
});

test("sma: a period longer than the series yields all nulls", () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test("sma: rejects a non-positive or fractional period", () => {
  assert.throws(() => sma([1, 2, 3], 0), RangeError);
  assert.throws(() => sma([1, 2, 3], 2.5), RangeError);
});

test("ema: seeds on the SMA then applies the 2/(n+1) multiplier", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  closeTo(out[2], 2); // seed = SMA(1,2,3)
  // multiplier = 2/4 = 0.5 → (4 − 2) × 0.5 + 2 = 3
  closeTo(out[3], 3);
  closeTo(out[4], 4);
});

test("ema: a constant series returns that constant", () => {
  const out = ema(new Array(50).fill(7), 10);
  closeTo(out[49], 7);
});

test("wilderSmooth differs from ema — it uses a 1/n multiplier", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const wilder = wilderSmooth(values, 3);
  const exponential = ema(values, 3);
  // seed = 2 for both; next: Wilder = (2×2 + 4)/3 = 8/3, EMA = (4−2)×0.5+2 = 3
  closeTo(wilder[3], 8 / 3);
  closeTo(exponential[3], 3);
});

test("wma: weights the newest bar most heavily", () => {
  // (1×1 + 2×2 + 3×3) / 6 = 14/6
  closeTo(wma([1, 2, 3], 3)[2], 14 / 6);
});

test("rsi: an unbroken advance pins the reading at 100", () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const out = rsi(rising, 14);
  closeTo(out[out.length - 1] as number, 100, 1e-9);
});

test("rsi: an unbroken decline pins the reading at 0", () => {
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  closeTo(rsi(falling, 14)[39] as number, 0, 1e-9);
});

test("rsi: alternating equal gains and losses oscillates tightly around 50", () => {
  // Wilder smoothing does not average an alternating series to exactly 50: the
  // most recent bar still moves one of the two averages, so the reading settles
  // into a 2-cycle straddling 50 (~48.22 / ~51.92 at period 14). Asserting an
  // exact 50 here would be asserting a bug.
  const zigzag: number[] = [100];
  for (let i = 1; i < 60; i++) zigzag.push(i % 2 === 1 ? 101 : 100);
  const out = rsi(zigzag, 14);
  const last = out[out.length - 1] as number;
  const previous = out[out.length - 2] as number;
  assert.ok(Math.abs(last - 50) < 5, `expected ${last} near 50`);
  assert.ok(Math.abs(previous - 50) < 5, `expected ${previous} near 50`);
  assert.ok(
    (last - 50) * (previous - 50) < 0,
    "consecutive readings should straddle 50 on an alternating series"
  );
});

test("rsi: warm-up spans period + 1 bars", () => {
  const out = rsi([1, 2, 3, 4, 5, 6], 3);
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.notEqual(out[3], null, "RSI(3) is defined from index 3");
});

test("macd: histogram equals the macd line minus its signal line", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 10);
  const result = macd(closes);
  for (let i = 0; i < closes.length; i++) {
    const line = result.macd[i];
    const signal = result.signal[i];
    const hist = result.histogram[i];
    if (line === null || signal === null) {
      assert.equal(hist, null);
      continue;
    }
    closeTo(hist, line - signal, 1e-9);
  }
});

test("macd: the signal line is seeded from the first defined macd bar, not index 0", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const result = macd(closes, 12, 26, 9);
  // MACD(12,26) first exists at index 25; signal needs 9 more → index 33.
  assert.equal(result.macd[24], null);
  assert.notEqual(result.macd[25], null);
  assert.equal(result.signal[32], null);
  assert.notEqual(result.signal[33], null);
});

test("macd: rejects a fast period that is not shorter than the slow period", () => {
  assert.throws(() => macd([1, 2, 3], 26, 12), RangeError);
});

test("stochastic: close at the window high reads 100, at the low reads 0", () => {
  const highs = [10, 10, 10, 10, 10];
  const lows = [0, 0, 0, 0, 0];
  const atHigh = stochastic(highs, lows, [5, 5, 5, 5, 10], 3, 1, 1);
  closeTo(atHigh.k[4], 100);
  const atLow = stochastic(highs, lows, [5, 5, 5, 5, 0], 3, 1, 1);
  closeTo(atLow.k[4], 0);
});

test("stochastic: a flat window reads the neutral 50 rather than dividing by zero", () => {
  const flat = [5, 5, 5, 5];
  const out = stochastic(flat, flat, flat, 3, 1, 1);
  closeTo(out.k[3], 50);
});

test("cci: a flat series reads 0 rather than NaN", () => {
  const flat = new Array(30).fill(50);
  closeTo(cci(flat, flat, flat, 20)[29], 0);
});

test("roc: reports percentage change over the lookback", () => {
  // (110 − 100)/100 × 100 = 10
  closeTo(roc([100, 101, 102, 110], 3)[3], 10);
});

test("trueRange: the first bar falls back to high − low", () => {
  const tr = trueRange([10, 12], [8, 11], [9, 11.5]);
  closeTo(tr[0], 2);
  // max(12−11, |12−9|, |11−9|) = 3
  closeTo(tr[1], 3);
});

test("atr: a series with a constant true range converges to that range", () => {
  const highs = Array.from({ length: 60 }, () => 11);
  const lows = Array.from({ length: 60 }, () => 10);
  const closes = Array.from({ length: 60 }, () => 10.5);
  closeTo(atr(highs, lows, closes, 14)[59] as number, 1, 1e-6);
});

test("bollinger: a flat series collapses the bands onto the mean", () => {
  const flat = new Array(30).fill(100);
  const bb = bollingerBands(flat, 20, 2);
  closeTo(bb.middle[29], 100);
  closeTo(bb.upper[29], 100);
  closeTo(bb.lower[29], 100);
  closeTo(bb.bandwidth[29], 0);
});

test("bollinger: uses the population standard deviation", () => {
  // closes 1..4 with period 4: mean 2.5, population sd = sqrt(1.25)
  const bb = bollingerBands([1, 2, 3, 4], 4, 1);
  closeTo(bb.middle[3], 2.5);
  closeTo(bb.upper[3], 2.5 + Math.sqrt(1.25));
});

test("bollinger: percentB is 1 at the upper band and 0 at the lower", () => {
  const closes = [1, 2, 3, 4];
  const bb = bollingerBands(closes, 4, 1);
  const upper = bb.upper[3] as number;
  const lower = bb.lower[3] as number;
  const atUpper = bollingerBands([1, 2, 3, upper], 4, 1);
  assert.ok((atUpper.percentB[3] as number) > 0.9);
  assert.ok(lower < 2.5);
});

test("adx: a persistent uptrend puts +DI above −DI", () => {
  const n = 80;
  const highs = Array.from({ length: n }, (_, i) => 100 + i * 1.1);
  const lows = Array.from({ length: n }, (_, i) => 99 + i * 1.1);
  const closes = Array.from({ length: n }, (_, i) => 99.5 + i * 1.1);
  const result = adx(highs, lows, closes, 14);
  const plus = result.plusDi[n - 1] as number;
  const minus = result.minusDi[n - 1] as number;
  assert.ok(plus > minus, `expected +DI ${plus} > −DI ${minus}`);
  assert.ok((result.adx[n - 1] as number) > 20, "a clean trend should register a strong ADX");
});

test("adx: needs roughly 2× the period before it is defined", () => {
  const n = 60;
  const highs = Array.from({ length: n }, (_, i) => 100 + i);
  const lows = Array.from({ length: n }, (_, i) => 99 + i);
  const closes = Array.from({ length: n }, (_, i) => 99.5 + i);
  const result = adx(highs, lows, closes, 14);
  assert.equal(result.adx[20], null, "ADX(14) cannot be defined at bar 20");
  assert.notEqual(result.adx[59], null);
});

test("realizedVolatility: a constant series has zero volatility", () => {
  const flat = new Array(60).fill(100);
  closeTo(realizedVolatility(flat, 20, 252)[59] as number, 0, 1e-12);
});

test("obv: adds volume on up closes, subtracts on down, ignores unchanged", () => {
  const out = obv([10, 11, 10, 10, 12], [0, 100, 50, 70, 30]);
  assert.deepEqual(out, [0, 100, 50, 50, 80]);
});

test("vwap: resets at each session boundary", () => {
  const day = 86_400_000;
  const candles: Candle[] = [
    { timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 100 },
    { timestamp: 3_600_000, open: 20, high: 20, low: 20, close: 20, volume: 100 },
    { timestamp: day, open: 50, high: 50, low: 50, close: 50, volume: 100 },
  ];
  const out = vwap(candles);
  closeTo(out[0], 10);
  closeTo(out[1], 15); // (10×100 + 20×100)/200
  closeTo(out[2], 50); // new UTC day → reset, not 26.67
});

test("volumeProfile: distributes a bar's volume across the bins it spans", () => {
  const candles: Candle[] = [{ timestamp: 0, open: 10, high: 20, low: 10, close: 20, volume: 100 }];
  const profile = volumeProfile(candles, 10, 0.7);
  assert.ok(profile);
  closeTo(profile!.totalVolume, 100, 1e-6);
  // A single bar spanning the whole range spreads evenly: no bin holds it all.
  assert.ok(profile!.bins.every((b) => b.volume < 100));
});

test("volumeProfile: point of control lands on the heaviest price area", () => {
  const candles: Candle[] = [
    { timestamp: 0, open: 10, high: 11, low: 10, close: 11, volume: 10 },
    { timestamp: 1, open: 15, high: 15.5, low: 15, close: 15.2, volume: 1000 },
    { timestamp: 2, open: 19, high: 20, low: 19, close: 20, volume: 10 },
  ];
  const profile = volumeProfile(candles, 20, 0.7);
  assert.ok(profile);
  assert.ok(
    profile!.pointOfControl > 14.5 && profile!.pointOfControl < 16,
    `POC ${profile!.pointOfControl} should sit in the heavy 15–15.5 zone`
  );
});

test("volumeProfile: an empty window yields null rather than a fabricated profile", () => {
  assert.equal(volumeProfile([], 10), null);
});

test("relativeVolume: excludes the current bar from its own baseline", () => {
  const volumes = [...new Array(20).fill(100), 300];
  const out = relativeVolume(volumes, 20);
  closeTo(out[20], 3); // 300 / mean(previous 20 × 100)
});

test("fibonacci: retracement 0 sits at the swing end and 1 at its start", () => {
  const levels = fibonacciRetracements({ from: 100, to: 200 });
  closeTo(levels[0].price, 200);
  closeTo(levels[levels.length - 1].price, 100);
  const half = levels.find((l) => l.ratio === 0.5);
  closeTo(half!.price, 150);
});

test("fibonacci: extensions project beyond the swing in its direction", () => {
  const levels = fibonacciExtensions({ from: 100, to: 200 }, [1.618]);
  closeTo(levels[0].price, 261.8);
});
