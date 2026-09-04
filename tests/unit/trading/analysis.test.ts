/**
 * Freshness gate, market structure, multi-timeframe and signal engine
 * (master spec §3, §6, §7, §8, §32, §35, §41).
 *
 * The behavioural contracts here are the ones the spec calls out as
 * non-negotiable: stale data disables live analysis, conflicting timeframes
 * never collapse into a BUY, and no score is ever emitted without factors.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FRESHNESS_POLICY,
  StaleDataError,
  assertLiveAnalysisAllowed,
  evaluateProvenance,
  evaluateSeries,
  inspectSeriesIntegrity,
  normalizeCandles,
} from "@/lib/trading/freshness";
import {
  analyzeStructure,
  classifyTrend,
  findLevels,
  findSwings,
  labelSwings,
} from "@/lib/trading/structure";
import { analyzeMultiTimeframe } from "@/lib/trading/mtf";
import { detectRegime, riskMultiplierForRegime, weightsForRegime } from "@/lib/trading/regime";
import { computeSignal } from "@/lib/trading/signal";
import { computeIndicatorSet } from "@/lib/trading/indicators";
import type { Candle, CandleSeries } from "@/lib/trading/types";

const instrument = { symbol: "TEST", assetClass: "stock" as const };

// ---------------------------------------------------------------------------
// Freshness (§3, §32)
// ---------------------------------------------------------------------------

test("freshness: a LIVE stamp inside the budget stays LIVE and permits analysis", () => {
  const now = 1_000_000;
  const verdict = evaluateProvenance(
    { source: "p", timestamp: now - 1_000, status: "LIVE" },
    15_000,
    now
  );
  assert.equal(verdict.status, "LIVE");
  assert.equal(verdict.liveAnalysisAllowed, true);
});

test("freshness: a LIVE stamp past the budget degrades to STALE", () => {
  const now = 1_000_000;
  const verdict = evaluateProvenance(
    { source: "p", timestamp: now - 60_000, status: "LIVE" },
    15_000,
    now
  );
  assert.equal(verdict.status, "STALE");
  assert.equal(verdict.liveAnalysisAllowed, false);
});

test("freshness: a far-future timestamp is treated as a fault, not as fresh", () => {
  const now = 1_000_000;
  const verdict = evaluateProvenance(
    { source: "p", timestamp: now + 600_000, status: "LIVE" },
    15_000,
    now
  );
  assert.equal(verdict.status, "STALE");
  assert.match(verdict.reason, /future/);
});

test("freshness: HISTORICAL and SIMULATED never permit live analysis regardless of age", () => {
  const now = 1_000_000;
  for (const status of ["HISTORICAL", "SIMULATED", "PAPER"] as const) {
    const verdict = evaluateProvenance({ source: "p", timestamp: now, status }, 15_000, now);
    assert.equal(verdict.liveAnalysisAllowed, false, `${status} must not allow live analysis`);
  }
});

test("freshness: DELAYED data still permits analysis but keeps its label", () => {
  const now = 1_000_000;
  const verdict = evaluateProvenance(
    { source: "p", timestamp: now - 1_000, status: "DELAYED" },
    15_000,
    now
  );
  assert.equal(verdict.status, "DELAYED");
  assert.equal(verdict.liveAnalysisAllowed, true);
});

test("freshness: an empty series is UNAVAILABLE, not fresh", () => {
  const series: CandleSeries = {
    instrument,
    timeframe: "1m",
    candles: [],
    provenance: { source: "p", timestamp: Date.now(), status: "LIVE" },
  };
  assert.equal(evaluateSeries(series).status, "UNAVAILABLE");
});

test("freshness: a series ages from its newest bar's CLOSE time", () => {
  const now = 10_000_000;
  const series: CandleSeries = {
    instrument,
    timeframe: "1m",
    // Opens 60s ago → closes now. Well within a 2.5× (150s) budget.
    candles: [{ timestamp: now - 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    provenance: { source: "p", timestamp: now - 60_000, status: "LIVE" },
  };
  assert.equal(evaluateSeries(series, DEFAULT_FRESHNESS_POLICY, now).liveAnalysisAllowed, true);

  const old: CandleSeries = {
    ...series,
    candles: [{ timestamp: now - 600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
  };
  assert.equal(evaluateSeries(old, DEFAULT_FRESHNESS_POLICY, now).liveAnalysisAllowed, false);
});

test("freshness: assertLiveAnalysisAllowed throws a typed error on stale data", () => {
  const verdict = evaluateProvenance(
    { source: "p", timestamp: 0, status: "LIVE" },
    1_000,
    1_000_000
  );
  assert.throws(() => assertLiveAnalysisAllowed(verdict), StaleDataError);
});

test("integrity: detects out-of-order, duplicate, gapped and impossible bars", () => {
  const report = inspectSeriesIntegrity(
    [
      { timestamp: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { timestamp: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, // duplicate
      { timestamp: 180_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, // gap
      { timestamp: 120_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, // out of order
      { timestamp: 300_000, open: 1, high: 0.1, low: 5, close: 1.5, volume: 10 }, // high < low
    ],
    "1m"
  );
  assert.equal(report.duplicates, 1);
  assert.equal(report.outOfOrder, 1);
  assert.ok(report.gaps >= 1);
  assert.equal(report.invalidOhlc, 1);
  assert.equal(report.ok, false);
});

test("normalizeCandles: sorts, de-duplicates last-write-wins and drops impossible bars", () => {
  const normalized = normalizeCandles([
    { timestamp: 200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { timestamp: 100, open: 1, high: 2, low: 0.5, close: 9, volume: 1 }, // revision
    { timestamp: 300, open: 1, high: 0.1, low: 5, close: 1, volume: 1 }, // impossible
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].timestamp, 100);
  assert.equal(normalized[0].close, 9, "a later revision of the same bar must win");
  assert.equal(normalized[1].timestamp, 200);
});

// ---------------------------------------------------------------------------
// Market structure (§6)
// ---------------------------------------------------------------------------

function candlesFrom(prices: readonly number[], step = 60_000): Candle[] {
  return prices.map((p, i) => ({
    timestamp: i * step,
    open: p,
    high: p + 0.5,
    low: p - 0.5,
    close: p,
    volume: 1_000,
  }));
}

test("structure: a swing needs a confirmed right side — no look-ahead", () => {
  // Peak at index 5; with lookback 3 it cannot be reported before index 8 exists.
  const prices = [1, 2, 3, 4, 5, 10, 5, 4, 3];
  const swings = findSwings(candlesFrom(prices), 3);
  const high = swings.find((s) => s.kind === "high");
  assert.ok(high, "the peak should be detected once its right side exists");
  assert.equal(high!.index, 5);

  // Truncated so the right side is missing → nothing may be reported.
  const truncated = findSwings(candlesFrom(prices.slice(0, 7)), 3);
  assert.equal(
    truncated.filter((s) => s.kind === "high").length,
    0,
    "a swing must not be reported before its confirmation bars exist"
  );
});

test("structure: labels higher highs and higher lows correctly", () => {
  const swings = labelSwings([
    { index: 0, timestamp: 0, price: 10, kind: "high" },
    { index: 1, timestamp: 1, price: 5, kind: "low" },
    { index: 2, timestamp: 2, price: 12, kind: "high" },
    { index: 3, timestamp: 3, price: 7, kind: "low" },
  ]);
  assert.equal(swings[0].label, null, "the first swing of a kind has nothing to compare to");
  assert.equal(swings[2].label, "HH");
  assert.equal(swings[3].label, "HL");
});

test("structure: an uptrend requires BOTH higher highs and higher lows", () => {
  const broadening = classifyTrend([
    { index: 0, timestamp: 0, price: 12, kind: "high", label: "HH" },
    { index: 1, timestamp: 1, price: 4, kind: "low", label: "LL" },
    { index: 2, timestamp: 2, price: 14, kind: "high", label: "HH" },
    { index: 3, timestamp: 3, price: 3, kind: "low", label: "LL" },
  ]);
  assert.notEqual(
    broadening.trend,
    "uptrend",
    "higher highs with lower lows is a broadening formation, not an uptrend"
  );

  const genuine = classifyTrend([
    { index: 0, timestamp: 0, price: 12, kind: "high", label: "HH" },
    { index: 1, timestamp: 1, price: 8, kind: "low", label: "HL" },
    { index: 2, timestamp: 2, price: 14, kind: "high", label: "HH" },
    { index: 3, timestamp: 3, price: 10, kind: "low", label: "HL" },
  ]);
  assert.equal(genuine.trend, "uptrend");
});

test("structure: too few swings yields undetermined rather than a guess", () => {
  assert.equal(classifyTrend([]).trend, "undetermined");
});

test("structure: levels cluster nearby swings and count their touches", () => {
  const { resistance } = findLevels(
    [
      { index: 0, timestamp: 0, price: 100.0, kind: "high" },
      { index: 5, timestamp: 5, price: 100.1, kind: "high" },
      { index: 9, timestamp: 9, price: 100.05, kind: "high" },
      { index: 12, timestamp: 12, price: 130.0, kind: "high" },
    ],
    0.0025
  );
  const strongest = resistance[0];
  assert.equal(strongest.touches, 3, "the three levels near 100 must merge into one");
  assert.ok(Math.abs(strongest.price - 100.05) < 0.1);
});

test("structure: a failed breakout is reported as a fakeout", () => {
  // Build a clean swing high, break above it, then close back below.
  const prices = [10, 10.2, 10.4, 10.6, 11.5, 10.6, 10.4, 10.2, 10.3, 10.5, 12.5, 10.1, 10.0];
  const structure = analyzeStructure(candlesFrom(prices), { swingLookback: 2 });
  const kinds = structure.events.map((e) => e.kind);
  assert.ok(kinds.includes("breakout"), `expected a breakout, got ${kinds.join(",")}`);
  assert.ok(kinds.includes("fakeout"), `expected a fakeout, got ${kinds.join(",")}`);
});

// ---------------------------------------------------------------------------
// Multi-timeframe (§7)
// ---------------------------------------------------------------------------

/**
 * A trending series that actually PULLS BACK. The oscillation amplitude must
 * beat the drift per bar (here max sine slope 4/4 = 1.0 against a 0.4 drift),
 * otherwise the series is monotonic, has no interior swing points, and no
 * structure engine can classify it — which is correct behaviour, not a bug.
 */
function trending(direction: 1 | -1, count = 140): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + direction * i * 0.4 + Math.sin(i / 4) * 4;
    candles.push({
      timestamp: i * 60_000,
      open: close - direction * 0.1,
      high: close + 0.7,
      low: close - 0.7,
      close,
      volume: 5_000,
    });
  }
  return candles;
}

test("mtf: an aligned bullish read is reported as aligned, not conflicted", () => {
  const analysis = analyzeMultiTimeframe([
    { timeframe: "1D", candles: trending(1) },
    { timeframe: "4H", candles: trending(1) },
    { timeframe: "1H", candles: trending(1) },
  ]);
  assert.equal(analysis.alignment, "aligned_bullish");
  assert.ok(analysis.aggregateBias > 0);
  assert.equal(analysis.conflicts.length, 0);
});

test("mtf: the spec's worked example does not collapse into a BUY", () => {
  // 1D/4H/1H bullish, 15m bearish → "higher-timeframe trend with a pullback".
  const analysis = analyzeMultiTimeframe([
    { timeframe: "1D", candles: trending(1) },
    { timeframe: "4H", candles: trending(1) },
    { timeframe: "1H", candles: trending(1) },
    { timeframe: "15m", candles: trending(-1) },
  ]);
  assert.equal(analysis.alignment, "conflicted");
  assert.ok(analysis.conflicts.length > 0);
  assert.match(analysis.narrative, /pullback/i);
  assert.ok(
    analysis.aggregateBias > 0,
    "the higher-timeframe trend should still dominate the aggregate"
  );
});

test("mtf: higher timeframes outweigh lower ones in the aggregate", () => {
  const dailyBull = analyzeMultiTimeframe([
    { timeframe: "1D", candles: trending(1) },
    { timeframe: "5m", candles: trending(-1) },
  ]);
  assert.ok(dailyBull.aggregateBias > 0, "a daily uptrend must outweigh a 5m downtrend");
});

test("mtf: no data yields a neutral read rather than an invented one", () => {
  const analysis = analyzeMultiTimeframe([]);
  assert.equal(analysis.alignment, "neutral");
  assert.equal(analysis.aggregateBias, 0);
});

// ---------------------------------------------------------------------------
// Regime (§16)
// ---------------------------------------------------------------------------

test("regime: too few bars yields undetermined with zero confidence", () => {
  const assessment = detectRegime({ candles: trending(1, 10) });
  assert.equal(assessment.regime, "undetermined");
  assert.equal(assessment.confidence, 0);
});

test("regime: a clean trend is classified as trending or momentum", () => {
  const assessment = detectRegime({ candles: trending(1) });
  assert.ok(
    ["trending", "momentum"].includes(assessment.regime),
    `expected a trending regime, got ${assessment.regime}`
  );
  assert.ok(assessment.riskMultiplier > 0.5);
});

test("regime: weights are normalised to sum to 1 for every regime", () => {
  for (const regime of [
    "trending",
    "ranging",
    "high_volatility",
    "low_volatility",
    "breakout",
    "panic",
    "momentum",
    "mean_reversion",
    "undetermined",
  ] as const) {
    const total = Object.values(weightsForRegime(regime)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${regime} weights sum to ${total}`);
  }
});

test("regime: a trending market weights trend above levels; a range does the reverse", () => {
  const trend = weightsForRegime("trending");
  const range = weightsForRegime("ranging");
  assert.ok(trend.trend > trend.levels);
  assert.ok(range.levels > range.trend);
});

test("regime: panic conditions cut the permitted risk sharply", () => {
  const panic = detectRegime({ candles: trending(1) });
  assert.ok(panic.riskMultiplier <= 1);
  // Explicit check on the mapping rather than trying to synthesise a panic tape.
  assert.ok(riskMultiplierForRegime("panic") <= 0.25);
  assert.ok(riskMultiplierForRegime("high_volatility") <= 0.5);
});

// ---------------------------------------------------------------------------
// Signal engine (§8, §34, §35)
// ---------------------------------------------------------------------------

function signalInputFor(candles: Candle[], overrides: Record<string, unknown> = {}) {
  return {
    candles,
    indicators: computeIndicatorSet(candles),
    structure: analyzeStructure(candles),
    regime: detectRegime({ candles }),
    mtf: null,
    liveDataAvailable: true,
    riskReward: 3,
    ...overrides,
  } as Parameters<typeof computeSignal>[0];
}

test("signal: stale data forces NO_TRADE regardless of how good the chart looks", () => {
  const result = computeSignal(signalInputFor(trending(1), { liveDataAvailable: false }));
  assert.equal(result.state, "NO_TRADE");
  assert.equal(result.tradeable, false);
  assert.ok(result.warnings.some((w) => w.code === "STALE_DATA" && w.severity === "critical"));
});

test("signal: every score carries the factors that produced it", () => {
  const result = computeSignal(signalInputFor(trending(1)));
  assert.ok(result.factors.length > 0, "a score must never be emitted without factors");
  for (const factor of result.factors) {
    assert.ok(factor.evidence.length > 0, `factor ${factor.id} has no evidence`);
    assert.ok(factor.value >= -1 && factor.value <= 1, `factor ${factor.id} out of range`);
    assert.ok(factor.weight > 0);
  }
});

test("signal: the score stays inside 0–100", () => {
  for (const direction of [1, -1] as const) {
    const result = computeSignal(signalInputFor(trending(direction)));
    assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} out of range`);
  }
});

test("signal: an uptrend scores above neutral and a downtrend below", () => {
  const bull = computeSignal(signalInputFor(trending(1)));
  const bear = computeSignal(signalInputFor(trending(-1)));
  assert.ok(bull.score > 50, `bullish tape scored ${bull.score}`);
  assert.ok(bear.score < 50, `bearish tape scored ${bear.score}`);
});

test("signal: conflicting timeframes never produce a BUY", () => {
  const candles = trending(1);
  const mtf = analyzeMultiTimeframe([
    { timeframe: "1D", candles: trending(1) },
    { timeframe: "15m", candles: trending(-1) },
  ]);
  const result = computeSignal(signalInputFor(candles, { mtf }));
  assert.equal(mtf.alignment, "conflicted");
  assert.ok(
    ["WAIT", "HOLD", "NO_TRADE"].includes(result.state),
    `conflicted timeframes produced ${result.state}`
  );
  assert.equal(result.tradeable, false);
});

test("signal: a poor risk/reward makes the setup untradeable", () => {
  const result = computeSignal(signalInputFor(trending(1), { riskReward: 0.4 }));
  assert.equal(result.tradeable, false);
});

test("signal: an unknown risk/reward is not treated as acceptable", () => {
  const result = computeSignal(signalInputFor(trending(1), { riskReward: null }));
  assert.equal(result.tradeable, false, "missing R:R must not pass the tradeable gate");
});

test("signal: the explanation states the decision and its reasons", () => {
  const result = computeSignal(signalInputFor(trending(1)));
  assert.match(result.explanation, /WHY (BUY|SELL|WAIT|NO TRADE)\?/);
  assert.match(result.explanation, /SETUP SCORE: \d+\/100/);
  assert.match(result.explanation, /DECISION:/);
  assert.match(result.explanation, /MARKET REGIME:/);
});

test("signal: agreement is reported in [0,1] and is not called a probability", () => {
  const result = computeSignal(signalInputFor(trending(1)));
  assert.ok(result.agreement >= 0 && result.agreement <= 1);
});

test("signal: missing news yields no news factor rather than a neutral one", () => {
  const withoutNews = computeSignal(signalInputFor(trending(1)));
  assert.equal(
    withoutNews.factors.some((f) => f.id === "news.sentiment"),
    false,
    "an unconfigured news provider must not contribute a factor"
  );
});

test("signal: grades reflect conviction and NO_TRADE never earns a letter grade", () => {
  const stale = computeSignal(signalInputFor(trending(1), { liveDataAvailable: false }));
  assert.equal(stale.grade, "NO_TRADE");
});
