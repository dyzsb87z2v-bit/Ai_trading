/**
 * Position monitor (§38), real-time reassessment (§39) and the daily report (§28).
 *
 * The governing property for the monitor is §40: it observes and recommends,
 * and there is no path through it that produces an order.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  monitorPosition,
  reassessSignal,
  type MonitoredPosition,
  type SignalSnapshot,
} from "@/lib/trading/positionMonitor";
import {
  DAILY_REPORT_SYSTEM_PROMPT,
  buildDailyReportMessages,
  buildDailyReportPacket,
  type DailyReportInput,
} from "@/lib/trading/dailyReport";
import { analyzeInstrument } from "@/lib/trading/analysisService";
import { DEFAULT_RISK_SETTINGS } from "@/lib/trading/positionSizing";
import type { Candle, CandleSeries, Quote } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const settings = { ...DEFAULT_RISK_SETTINGS, accountEquity: 100_000 };

function series(direction: 1 | -1, status: "LIVE" | "SIMULATED" = "LIVE"): CandleSeries {
  const candles: Candle[] = [];
  for (let i = 0; i < 200; i++) {
    const close = 100 + direction * i * 0.4 + Math.sin(i / 4) * 4;
    candles.push({
      timestamp: NOW - (200 - i) * HOUR,
      open: close - direction * 0.1,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 10_000 + (i % 5) * 800,
    });
  }
  return {
    instrument: { symbol: "AAA", assetClass: "stock" },
    timeframe: "1H",
    candles,
    provenance: { source: "test", timestamp: NOW - HOUR, status },
  };
}

function quote(last: number): Quote {
  return {
    instrument: { symbol: "AAA", assetClass: "stock" },
    last,
    bid: last - 0.01,
    ask: last + 0.01,
    spread: 0.02,
    volume: 1_000_000,
    tradeCount: 100,
    vwap: last,
    changePercent: 1.2,
    session: "regular",
    provenance: { source: "test", timestamp: NOW, status: "LIVE" },
  };
}

function analysisFor(direction: 1 | -1 = 1, status: "LIVE" | "SIMULATED" = "LIVE") {
  const s = series(direction, status);
  const last = s.candles[s.candles.length - 1].close;
  return analyzeInstrument({
    series: s,
    quote: status === "LIVE" ? quote(last) : null,
    settings,
    dailyPnl: 0,
    openPositions: [],
    now: NOW,
  });
}

const position = (over: Partial<MonitoredPosition> = {}): MonitoredPosition => ({
  symbol: "AAA",
  side: "long",
  quantity: 100,
  entryPrice: 150,
  stopPrice: 140,
  takeProfitPrice: 200,
  openedAt: NOW - 10 * HOUR,
  ...over,
});

// ---------------------------------------------------------------------------
// Position monitor
// ---------------------------------------------------------------------------

test("monitor: computes P&L, R multiple and distances from computed values", () => {
  const analysis = analysisFor(1);
  const result = monitorPosition(position(), analysis);
  assert.ok(result.currentPrice !== null);
  assert.ok(result.unrealizedPnl !== null);
  assert.ok(result.rMultiple !== null);
  assert.ok(result.distanceToStop !== null);
  assert.ok(result.observations.length > 0);
});

test("monitor: a price at or beyond the stop marks the trade invalidated", () => {
  const analysis = analysisFor(1);
  const price = analysis.levels?.preferredEntry ?? 0;
  // Put the stop above the current price on a long — i.e. already breached.
  const result = monitorPosition(position({ stopPrice: price + 5 }), analysis);
  assert.equal(result.trend, "invalidated");
  assert.equal(result.recommendation, "consider_exiting");
});

test("monitor: a falling setup score recommends reducing, never closing", () => {
  const analysis = analysisFor(1);
  const score = analysis.signal?.score ?? 50;
  const result = monitorPosition(
    position({ entryScore: score + 30, stopPrice: 1, takeProfitPrice: 1_000_000 }),
    analysis
  );
  assert.equal(result.trend, "weakening");
  assert.equal(result.recommendation, "consider_reducing");
  // §38/§40: the module must never itself act.
  assert.ok(!("order" in result));
  assert.ok(!("close" in result));
});

test("monitor: an improving score is reported as improving", () => {
  const analysis = analysisFor(1);
  const score = analysis.signal?.score ?? 50;
  const result = monitorPosition(
    position({ entryScore: score - 30, stopPrice: 1, takeProfitPrice: 1_000_000 }),
    analysis
  );
  assert.equal(result.trend, "improving");
  assert.ok((result.scoreDelta ?? 0) >= 10);
});

test("monitor: stale data makes the recommendation unknown, not a guess", () => {
  const analysis = analysisFor(1, "SIMULATED");
  const result = monitorPosition(position(), analysis);
  assert.equal(result.recommendation, "unknown");
  assert.match(result.recommendationReason, /LIVE ANALYSIS DISABLED/);
});

test("monitor: with no price at all it reports unknown rather than zeros", () => {
  const empty = analyzeInstrument({
    series: {
      instrument: { symbol: "AAA", assetClass: "stock" },
      timeframe: "1H",
      candles: [],
      provenance: { source: "test", timestamp: NOW, status: "LIVE" },
    },
    quote: null,
    settings,
    dailyPnl: 0,
    openPositions: [],
    now: NOW,
  });
  const result = monitorPosition(position(), empty);
  assert.equal(result.currentPrice, null);
  assert.equal(result.unrealizedPnl, null);
  assert.equal(result.recommendation, "unknown");
});

test("monitor: a short position's P&L has the opposite sign to a long's", () => {
  const analysis = analysisFor(1);
  const price = analysis.levels?.preferredEntry ?? 100;
  const long = monitorPosition(position({ entryPrice: price - 10 }), analysis);
  const short = monitorPosition(
    position({ side: "short", entryPrice: price - 10, stopPrice: price + 50, takeProfitPrice: 1 }),
    analysis
  );
  assert.ok((long.unrealizedPnl ?? 0) > 0);
  assert.ok((short.unrealizedPnl ?? 0) < 0);
});

// ---------------------------------------------------------------------------
// Reassessment
// ---------------------------------------------------------------------------

test("reassess: the first look records a baseline and reports no change", () => {
  const result = reassessSignal(null, analysisFor(1));
  assert.equal(result.changed, false);
  assert.match(result.summary, /Baseline recorded/);
});

test("reassess: a small score move is not reported as a change", () => {
  const analysis = analysisFor(1);
  const current = analysis.signal?.score ?? 50;
  const previous: SignalSnapshot = {
    state: analysis.signal?.state ?? "HOLD",
    score: current - 2,
    regime: analysis.regime?.regime ?? null,
    at: NOW - HOUR,
  };
  const result = reassessSignal(previous, analysis);
  assert.equal(result.changed, false);
  assert.match(result.reason, /below the 15-point threshold/);
});

test("reassess: a state change always counts as material", () => {
  const analysis = analysisFor(1);
  const previous: SignalSnapshot = {
    state: "STRONG_SELL",
    score: analysis.signal?.score ?? 50,
    regime: analysis.regime?.regime ?? null,
    at: NOW - HOUR,
  };
  const result = reassessSignal(previous, analysis);
  assert.equal(result.changed, true);
  assert.ok(result.triggers.includes("signal_change"));
});

test("reassess: the summary renders the spec's SIGNAL CHANGED block", () => {
  const analysis = analysisFor(1);
  const previous: SignalSnapshot = {
    state: "STRONG_SELL",
    score: 20,
    regime: null,
    at: NOW - HOUR,
  };
  const result = reassessSignal(previous, analysis);
  assert.match(result.summary, /^SIGNAL CHANGED/);
  assert.match(result.summary, /Previous:/);
  assert.match(result.summary, /Current:/);
  assert.match(result.summary, /Reason:/);
});

test("reassess: a large score move is material even with the same state", () => {
  const analysis = analysisFor(1);
  const state = analysis.signal?.state ?? "HOLD";
  const current = analysis.signal?.score ?? 50;
  const result = reassessSignal(
    { state, score: current - 40, regime: analysis.regime?.regime ?? null, at: NOW - HOUR },
    analysis
  );
  assert.equal(result.changed, true);
});

test("reassess: the threshold is configurable", () => {
  const analysis = analysisFor(1);
  const state = analysis.signal?.state ?? "HOLD";
  const current = analysis.signal?.score ?? 50;
  const previous = { state, score: current - 5, regime: analysis.regime?.regime ?? null, at: NOW };
  assert.equal(reassessSignal(previous, analysis).changed, false);
  assert.equal(reassessSignal(previous, analysis, { materialScoreDelta: 2 }).changed, true);
});

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------

const emptyReport = (over: Partial<DailyReportInput> = {}): DailyReportInput => ({
  generatedAt: NOW,
  overview: [],
  scan: null,
  news: null,
  events: null,
  portfolio: null,
  portfolioRisk: null,
  openPositions: [],
  ...over,
});

test("daily report: the system prompt forbids invention and forcing trades", () => {
  assert.match(DAILY_REPORT_SYSTEM_PROMPT, /Use ONLY the packet/);
  assert.match(DAILY_REPORT_SYSTEM_PROMPT, /Never promise, guarantee or imply/);
  assert.match(DAILY_REPORT_SYSTEM_PROMPT, /Never tell the reader to trade/);
  assert.match(DAILY_REPORT_SYSTEM_PROMPT, /No tradeable\s+setups today. is a complete/);
});

test("daily report: every missing section says UNAVAILABLE explicitly", () => {
  const packet = buildDailyReportPacket(emptyReport());
  assert.match(packet, /NEWS DATA UNAVAILABLE/);
  assert.match(packet, /ECONOMIC CALENDAR UNAVAILABLE/);
  assert.match(packet, /no broad-market instruments were analysed/);
  assert.match(packet, /no scan was run/);
});

test("daily report: an empty news array differs from an unconfigured provider", () => {
  const packet = buildDailyReportPacket(emptyReport({ news: [] }));
  assert.match(packet, /No articles in the requested window/);
  assert.doesNotMatch(packet, /NEWS DATA UNAVAILABLE/);
});

test("daily report: a scan with no tradeable setups says so plainly", () => {
  const packet = buildDailyReportPacket(
    emptyReport({
      scan: { hits: [], failures: [], scanned: 12, scannedAt: NOW },
    })
  );
  assert.match(packet, /Symbols scanned: 12/);
  assert.match(packet, /no setup cleared the risk engine today/);
});

test("daily report: unanalysable symbols are carried into the packet", () => {
  const packet = buildDailyReportPacket(
    emptyReport({
      scan: {
        hits: [],
        failures: [{ symbol: "BROKEN", reason: "no candles" }],
        scanned: 1,
        scannedAt: NOW,
      },
    })
  );
  assert.match(packet, /BROKEN: no candles/);
});

test("daily report: messages are the system prompt plus the packet", () => {
  const messages = buildDailyReportMessages(emptyReport());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[1].content, /=== REPORT PACKET ===/);
});

test("daily report: an unpriced portfolio holding is disclosed", () => {
  const packet = buildDailyReportPacket(
    emptyReport({
      portfolio: {
        totalEquity: 100_000,
        cash: 50_000,
        invested: 50_000,
        unrealizedPnl: 0,
        realizedPnl: 0,
        grossExposure: 0.5,
        netExposure: 0.5,
        unpricedSymbols: ["XYZ"],
        positions: 2,
      },
    })
  );
  assert.match(packet, /Unpriced, excluded from valuation: XYZ/);
});
