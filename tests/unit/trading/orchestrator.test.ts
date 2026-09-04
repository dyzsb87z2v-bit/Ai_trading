/**
 * Analysis orchestrator (master spec §8, §12, §35, §42, §45).
 *
 * The orchestrator is where the safety property lives: the risk engine runs
 * last and can veto everything upstream, and no caller can reach a TRADEABLE
 * verdict without passing it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { analyzeInstrument, type AnalysisRequest } from "@/lib/trading/analysisService";
import { DEFAULT_RISK_SETTINGS } from "@/lib/trading/positionSizing";
import type { Candle, CandleSeries, Quote } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const instrument = { symbol: "AAPL", assetClass: "stock" as const };

/** A trending series with genuine pullbacks, ending at `NOW`. */
function series(direction: 1 | -1, count = 200): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + direction * i * 0.4 + Math.sin(i / 4) * 4;
    candles.push({
      timestamp: NOW - (count - i) * HOUR,
      open: close - direction * 0.1,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 10_000 + (i % 5) * 800,
    });
  }
  return candles;
}

function candleSeries(
  candles: Candle[],
  status: CandleSeries["provenance"]["status"] = "LIVE"
): CandleSeries {
  return {
    instrument,
    timeframe: "1H",
    candles,
    provenance: { source: "test-provider", timestamp: NOW, status },
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  const candles = series(1);
  const last = candles[candles.length - 1].close;
  return {
    instrument,
    last,
    bid: last - 0.01,
    ask: last + 0.01,
    spread: 0.02,
    volume: 1_000_000,
    tradeCount: 5_000,
    vwap: last,
    changePercent: 1.2,
    session: "regular",
    provenance: { source: "test-provider", timestamp: NOW, status: "LIVE" },
    ...overrides,
  };
}

function request(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  return {
    series: candleSeries(series(1)),
    quote: quote(),
    settings: { ...DEFAULT_RISK_SETTINGS, accountEquity: 100_000 },
    dailyPnl: 0,
    openPositions: [],
    now: NOW,
    ...overrides,
  };
}

test("orchestrator: produces a complete, explainable result on good data", () => {
  const result = analyzeInstrument(request());
  assert.equal(result.symbol, "AAPL");
  assert.equal(result.dataStatus, "LIVE");
  assert.ok(result.structure, "structure must be computed");
  assert.ok(result.regime, "regime must be computed");
  assert.ok(result.signal, "a signal must be produced");
  assert.ok(result.risk, "the risk engine must have run");
  assert.ok(result.reasons.length > 0, "a verdict must always carry reasons");
});

test("orchestrator: stale candles disable live analysis and refuse a verdict", () => {
  const old = series(1).map((c) => ({ ...c, timestamp: c.timestamp - 30 * 86_400_000 }));
  const result = analyzeInstrument(request({ series: candleSeries(old), quote: null }));
  assert.equal(result.liveAnalysisAllowed, false);
  assert.equal(result.verdict, "DATA_UNAVAILABLE");
  assert.ok(result.reasons.some((r) => /LIVE ANALYSIS DISABLED/.test(r)));
});

test("orchestrator: a live quote does not rescue a stale candle series", () => {
  const old = series(1).map((c) => ({ ...c, timestamp: c.timestamp - 30 * 86_400_000 }));
  const result = analyzeInstrument(request({ series: candleSeries(old), quote: quote() }));
  assert.equal(result.liveAnalysisAllowed, false, "the worse of the two provenances must win");
});

test("orchestrator: a stale quote is not rescued by fresh candles either", () => {
  const result = analyzeInstrument(
    request({
      quote: quote({
        provenance: { source: "test-provider", timestamp: NOW - 600_000, status: "LIVE" },
      }),
    })
  );
  assert.equal(result.liveAnalysisAllowed, false);
});

test("orchestrator: HISTORICAL data still analyses but never becomes tradeable", () => {
  const result = analyzeInstrument(
    request({ series: candleSeries(series(1), "HISTORICAL"), quote: null })
  );
  assert.ok(result.structure, "a historical chart must still be analysable for display");
  assert.notEqual(result.verdict, "TRADEABLE");
});

test("orchestrator: the risk engine can veto an otherwise attractive setup", () => {
  // A daily loss already at the limit must block regardless of the chart.
  const result = analyzeInstrument(
    request({
      settings: { ...DEFAULT_RISK_SETTINGS, accountEquity: 100_000, maxDailyLossFraction: 0.01 },
      dailyPnl: -1_000,
    })
  );
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.reasons.some((r) => /daily limit/i.test(r)));
});

test("orchestrator: a closed market blocks the verdict", () => {
  const result = analyzeInstrument(request({ quote: quote({ session: "closed" }) }));
  assert.equal(result.verdict, "BLOCKED");
});

test("orchestrator: zero equity cannot produce a tradeable verdict", () => {
  const result = analyzeInstrument(
    request({ settings: { ...DEFAULT_RISK_SETTINGS, accountEquity: 0 } })
  );
  assert.notEqual(result.verdict, "TRADEABLE");
});

test("orchestrator: an empty series refuses with a data-unavailable verdict", () => {
  const result = analyzeInstrument(request({ series: candleSeries([]), quote: null }));
  assert.equal(result.verdict, "DATA_UNAVAILABLE");
  assert.ok(result.reasons.some((r) => /DATA SOURCE UNAVAILABLE/.test(r)));
});

test("orchestrator: series defects are surfaced rather than silently analysed", () => {
  const candles = series(1);
  const corrupted = [...candles, { ...candles[candles.length - 1] }]; // duplicate ts
  const result = analyzeInstrument(request({ series: candleSeries(corrupted) }));
  assert.equal(result.seriesIntegrity.ok, false);
  assert.ok(result.warnings.some((w) => w.code === "SERIES_INTEGRITY"));
});

test("orchestrator: multi-timeframe conflict is carried into the verdict", () => {
  const result = analyzeInstrument(
    request({
      additionalSeries: [
        { timeframe: "1D", candles: series(1) },
        { timeframe: "5m", candles: series(-1) },
      ],
    })
  );
  assert.ok(result.mtf, "MTF analysis must run when extra series are supplied");
  assert.equal(result.mtf?.alignment, "conflicted");
  assert.notEqual(result.verdict, "TRADEABLE", "a conflicted read must not be tradeable");
});

test("orchestrator: the copilot packet is built from the computed evidence", () => {
  const result = analyzeInstrument(request());
  assert.ok(result.copilotMessages);
  assert.equal(result.copilotMessages?.length, 2);
  assert.match(result.copilotMessages![1].content, /=== EVIDENCE PACKET ===/);
  assert.match(result.copilotMessages![1].content, /Symbol: AAPL/);
});

test("orchestrator: a TRADEABLE verdict implies the risk engine did not block", () => {
  const result = analyzeInstrument(request());
  if (result.verdict === "TRADEABLE") {
    assert.notEqual(result.risk?.verdict, "BLOCKED");
    assert.equal(result.signal?.tradeable, true);
    assert.ok((result.sizing?.quantity ?? 0) > 0);
    assert.ok(result.levels, "a tradeable verdict must carry levels");
  }
});

test("orchestrator: the sizing is capped by the regime risk multiplier", () => {
  const result = analyzeInstrument(request());
  if (result.sizing?.tradeable && result.regime) {
    const budget =
      100_000 * DEFAULT_RISK_SETTINGS.riskPerTradeFraction * result.regime.riskMultiplier;
    assert.ok(
      result.sizing.riskAmount <= budget + 1e-6,
      `risk ${result.sizing.riskAmount} exceeded the regime-adjusted budget ${budget}`
    );
  }
});

test("orchestrator: a short request produces short-side levels", () => {
  const result = analyzeInstrument(request({ side: "short", series: candleSeries(series(-1)) }));
  if (result.levels) {
    assert.equal(result.levels.side, "short");
    assert.ok(result.levels.stopLoss > result.levels.preferredEntry);
  }
});
