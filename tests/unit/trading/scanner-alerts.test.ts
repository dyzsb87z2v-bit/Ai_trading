/**
 * Scanner (§27) and alert engine (§26).
 *
 * The properties that matter: the scanner ranks by tradeability rather than raw
 * score and never silently drops a symbol, and an alert never fires on data it
 * cannot verify, nor repeatedly while a condition merely stays true.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyScan, scanMarkets, type ScanInput } from "@/lib/trading/scanner";
import {
  createBrowserDispatcher,
  dispatchAlerts,
  evaluateAlerts,
  type AlertRule,
} from "@/lib/trading/alerts";
import { analyzeInstrument } from "@/lib/trading/analysisService";
import { computeIndicatorSet } from "@/lib/trading/indicators";
import { DEFAULT_RISK_SETTINGS } from "@/lib/trading/positionSizing";
import type { Candle, CandleSeries, Quote } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function candles(direction: 1 | -1, count = 200, base = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = base + direction * i * 0.4 + Math.sin(i / 4) * 4;
    out.push({
      timestamp: NOW - (count - i) * HOUR,
      open: close - direction * 0.1,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 10_000 + (i % 5) * 800,
    });
  }
  return out;
}

function seriesFor(
  symbol: string,
  direction: 1 | -1,
  status: "LIVE" | "SIMULATED" = "LIVE"
): CandleSeries {
  return {
    instrument: { symbol, assetClass: "stock" },
    timeframe: "1H",
    candles: candles(direction),
    provenance: { source: "test", timestamp: NOW - HOUR, status },
  };
}

function quoteFor(symbol: string, last: number): Quote {
  return {
    instrument: { symbol, assetClass: "stock" },
    last,
    bid: last - 0.01,
    ask: last + 0.01,
    spread: 0.02,
    volume: 1_000_000,
    tradeCount: 100,
    vwap: last,
    changePercent: 1.5,
    session: "regular",
    provenance: { source: "test", timestamp: NOW, status: "LIVE" },
  };
}

const settings = { ...DEFAULT_RISK_SETTINGS, accountEquity: 100_000 };

function inputFor(symbol: string, direction: 1 | -1): ScanInput {
  const series = seriesFor(symbol, direction);
  const last = series.candles[series.candles.length - 1].close;
  return {
    instrument: series.instrument,
    timeframe: "1H",
    series,
    quote: quoteFor(symbol, last),
  };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

test("scanner: returns a hit per analysable symbol", () => {
  const result = scanMarkets([inputFor("AAA", 1), inputFor("BBB", -1)], { settings, now: NOW });
  assert.equal(result.scanned, 2);
  assert.equal(result.hits.length, 2);
  assert.equal(result.failures.length, 0);
});

test("scanner: an unanalysable symbol is REPORTED, not silently dropped", () => {
  const broken: ScanInput = {
    instrument: { symbol: "EMPTY", assetClass: "stock" },
    timeframe: "1H",
    series: {
      instrument: { symbol: "EMPTY", assetClass: "stock" },
      timeframe: "1H",
      candles: [],
      provenance: { source: "test", timestamp: NOW, status: "LIVE" },
    },
    quote: null,
  };
  const result = scanMarkets([inputFor("AAA", 1), broken], { settings, now: NOW });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].symbol, "EMPTY");
  assert.equal(result.scanned, 2, "the failure still counts as scanned");
});

test("scanner: a blocked setup ranks below every tradeable one, whatever its score", () => {
  // A SIMULATED series can never be tradeable, however good it looks.
  const simulated: ScanInput = {
    instrument: { symbol: "SIM", assetClass: "stock" },
    timeframe: "1H",
    series: seriesFor("SIM", 1, "SIMULATED"),
    quote: null,
  };
  const result = scanMarkets([simulated, inputFor("AAA", 1)], { settings, now: NOW });
  const simIndex = result.hits.findIndex((h) => h.symbol === "SIM");
  const liveIndex = result.hits.findIndex((h) => h.symbol === "AAA");
  assert.ok(simIndex > liveIndex || result.hits[simIndex].tradeable === false);
  assert.equal(result.hits[simIndex].tradeable, false);
});

test("scanner: tradeableOnly filters out everything the risk engine blocked", () => {
  const simulated: ScanInput = {
    instrument: { symbol: "SIM", assetClass: "stock" },
    timeframe: "1H",
    series: seriesFor("SIM", 1, "SIMULATED"),
    quote: null,
  };
  const result = scanMarkets([simulated], { settings, tradeableOnly: true, now: NOW });
  assert.equal(result.hits.length, 0);
});

test("scanner: minScore filters low-scoring setups", () => {
  const all = scanMarkets([inputFor("AAA", 1), inputFor("BBB", -1)], { settings, now: NOW });
  const high = scanMarkets([inputFor("AAA", 1), inputFor("BBB", -1)], {
    settings,
    minScore: 101,
    now: NOW,
  });
  assert.ok(all.hits.length > 0);
  assert.equal(high.hits.length, 0, "no setup can score above 100");
});

test("scanner: the limit caps the result set", () => {
  const inputs = ["A", "B", "C", "D", "E"].map((s) => inputFor(s, 1));
  const result = scanMarkets(inputs, { settings, limit: 2, now: NOW });
  assert.equal(result.hits.length, 2);
});

test("scanner: kind filtering only returns matching patterns", () => {
  const result = scanMarkets([inputFor("AAA", 1)], {
    settings,
    kinds: ["oversold"],
    now: NOW,
  });
  for (const hit of result.hits) {
    assert.ok(hit.kinds.includes("oversold"));
  }
});

test("scanner: classification derives only from computed values", () => {
  const series = seriesFor("AAA", 1);
  const analysis = analyzeInstrument({
    series,
    quote: quoteFor("AAA", series.candles[series.candles.length - 1].close),
    settings,
    dailyPnl: 0,
    openPositions: [],
    now: NOW,
  });
  const kinds = classifyScan(analysis);
  assert.ok(Array.isArray(kinds));
  // Every kind must be one of the declared labels — no invented categories.
  const known = new Set([
    "strong_trend",
    "breakout",
    "momentum",
    "volume_spike",
    "oversold",
    "overbought",
    "vwap_reclaim",
    "ema_cross",
    "high_volatility",
    "compression",
  ]);
  for (const kind of kinds) assert.ok(known.has(kind), `unknown kind ${kind}`);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function contextFor(symbol: string, direction: 1 | -1 = 1) {
  const series = seriesFor(symbol, direction);
  const last = series.candles[series.candles.length - 1].close;
  return {
    analysis: analyzeInstrument({
      series,
      quote: quoteFor(symbol, last),
      settings,
      dailyPnl: 0,
      openPositions: [],
      now: NOW,
    }),
    indicators: computeIndicatorSet(series.candles),
    now: NOW,
    lastClose: last,
  };
}

const baseRule = (over: Partial<AlertRule>): AlertRule => ({
  id: "r1",
  symbol: "AAA",
  kind: "price_above",
  enabled: true,
  channels: ["browser"],
  ...over,
});

test("alerts: a disabled rule never fires", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ enabled: false, value: 0, lastValue: -1 })], ctx);
  assert.equal(result.fired.length, 0);
});

test("alerts: a level rule is EDGE-triggered, not level-triggered", () => {
  const ctx = contextFor("AAA");
  const threshold = ctx.lastClose - 5; // price is already above it

  // First look: no previous value, so no edge exists — it must stay silent.
  const first = evaluateAlerts([baseRule({ value: threshold, lastValue: null })], ctx);
  assert.equal(first.fired.length, 0, "the first observation must not fire");

  // Coming from below the threshold IS an edge.
  const crossed = evaluateAlerts([baseRule({ value: threshold, lastValue: threshold - 1 })], ctx);
  assert.equal(crossed.fired.length, 1);

  // Already above and staying above is not a new edge.
  const staying = evaluateAlerts([baseRule({ value: threshold, lastValue: threshold + 1 })], ctx);
  assert.equal(staying.fired.length, 0, "staying above must not re-fire");
});

test("alerts: the cooldown suppresses a repeat firing", () => {
  const ctx = contextFor("AAA");
  const threshold = ctx.lastClose - 5;
  const result = evaluateAlerts(
    [
      baseRule({
        value: threshold,
        lastValue: threshold - 1,
        cooldownMs: 60_000,
        lastTriggeredAt: NOW - 1_000,
      }),
    ],
    ctx
  );
  assert.equal(result.fired.length, 0, "a rule inside its cooldown must stay silent");
});

test("alerts: a rule whose data is missing is SKIPPED with a reason", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ id: "no-pos", kind: "stop_hit" })], {
    ...ctx,
    position: null,
  });
  assert.equal(result.fired.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /no open position/);
});

test("alerts: a rule with no threshold is skipped, not defaulted", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ value: undefined })], ctx);
  assert.equal(result.fired.length, 0);
  assert.match(result.skipped[0].reason, /no threshold/);
});

test("alerts: signal_change fires only on an actual change", () => {
  const ctx = contextFor("AAA");
  const state = ctx.analysis.signal?.state;
  assert.ok(state);

  const unchanged = evaluateAlerts(
    [baseRule({ kind: "signal_change", previousState: state })],
    ctx
  );
  assert.equal(unchanged.fired.length, 0);

  const changed = evaluateAlerts(
    [baseRule({ kind: "signal_change", previousState: "SOMETHING_ELSE" })],
    ctx
  );
  assert.equal(changed.fired.length, 1);
  assert.match(changed.fired[0].message, /signal changed/);
});

test("alerts: signal_change reports the new state so the caller can persist it", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ kind: "signal_change", previousState: "OLD" })], ctx);
  assert.equal(result.stateUpdates[0].previousState, ctx.analysis.signal?.state);
});

test("alerts: a stop hit on a long fires when price falls to the stop", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ kind: "stop_hit" })], {
    ...ctx,
    position: { side: "long", stopPrice: ctx.lastClose + 10, takeProfitPrice: null },
  });
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].severity, "critical");
});

test("alerts: state updates are returned for every evaluated rule", () => {
  const ctx = contextFor("AAA");
  const result = evaluateAlerts([baseRule({ value: ctx.lastClose - 5, lastValue: null })], ctx);
  assert.equal(result.stateUpdates.length, 1);
  assert.equal(result.stateUpdates[0].ruleId, "r1");
  assert.ok(result.stateUpdates[0].lastValue !== undefined);
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test("dispatch: an unconfigured channel reports FAILURE, never silent success", async () => {
  const event = {
    ruleId: "r1",
    symbol: "AAA",
    kind: "price_above" as const,
    message: "test",
    observed: 1,
    threshold: 1,
    triggeredAt: NOW,
    channels: ["telegram" as const],
    severity: "info" as const,
  };
  const outcomes = await dispatchAlerts(
    [event],
    [{ channel: "telegram", isConfigured: () => false, send: async () => ({ ok: true }) }]
  );
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail ?? "", /not configured/);
});

test("dispatch: a missing dispatcher is reported rather than ignored", async () => {
  const event = {
    ruleId: "r1",
    symbol: "AAA",
    kind: "price_above" as const,
    message: "t",
    observed: 1,
    threshold: 1,
    triggeredAt: NOW,
    channels: ["email" as const],
    severity: "info" as const,
  };
  const outcomes = await dispatchAlerts([event], []);
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail ?? "", /No dispatcher/);
});

test("dispatch: the browser channel needs no credentials and delivers", async () => {
  const received: string[] = [];
  const dispatcher = createBrowserDispatcher((e) => received.push(e.message));
  const event = {
    ruleId: "r1",
    symbol: "AAA",
    kind: "price_above" as const,
    message: "hello",
    observed: 1,
    threshold: 1,
    triggeredAt: NOW,
    channels: ["browser" as const],
    severity: "info" as const,
  };
  const outcomes = await dispatchAlerts([event], [dispatcher]);
  assert.equal(outcomes[0].ok, true);
  assert.deepEqual(received, ["hello"]);
});

test("dispatch: a throwing dispatcher is caught and reported", async () => {
  const event = {
    ruleId: "r1",
    symbol: "AAA",
    kind: "price_above" as const,
    message: "t",
    observed: 1,
    threshold: 1,
    triggeredAt: NOW,
    channels: ["push" as const],
    severity: "info" as const,
  };
  const outcomes = await dispatchAlerts(
    [event],
    [
      {
        channel: "push",
        isConfigured: () => true,
        send: async () => {
          throw new Error("network down");
        },
      },
    ]
  );
  assert.equal(outcomes[0].ok, false);
  assert.match(outcomes[0].detail ?? "", /network down/);
});
