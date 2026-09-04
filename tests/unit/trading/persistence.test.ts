/**
 * Persistence against a real SQLite database.
 *
 * These exercise the schema itself, not a mock: the tables, the indexes and the
 * upsert semantics all have to hold on the real driver.
 *
 * The suite isolates DATA_DIR and closes the connection in `after`, otherwise
 * the node test runner hangs on an open SQLite handle.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import * as db from "@/lib/db/trading";

let tempDir: string;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "att-test-"));
  process.env.DATA_DIR = tempDir;
  getDb();
});

after(() => {
  closeDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test("schema: every table exists after bootstrap", () => {
  const names = new Set(
    (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name)
  );
  for (const expected of [
    "instruments",
    "candles",
    "signals",
    "risk_settings",
    "watchlists",
    "accounts",
    "orders",
    "positions",
    "journal_entries",
    "backtests",
    "provider_connections",
  ]) {
    assert.ok(names.has(expected), `missing table ${expected}`);
  }
});

test("instruments: upsert then read back", () => {
  db.upsertInstrument({
    symbol: "AAPL",
    assetClass: "stock",
    exchange: "XNAS",
    currency: "USD",
    sector: "tech",
  });
  const row = db.getInstrument("AAPL");
  assert.equal(row?.symbol, "AAPL");
  assert.equal(row?.sector, "tech");
  assert.equal(row?.contractSize, 1);
});

test("instruments: a second upsert updates rather than duplicating", () => {
  db.upsertInstrument({ symbol: "AAPL", assetClass: "stock", sector: "technology" });
  assert.equal(db.getInstrument("AAPL")?.sector, "technology");
  assert.equal(db.listInstruments().filter((i) => i.symbol === "AAPL").length, 1);
});

test("candles: stored with provenance and returned ascending", () => {
  db.upsertCandles("AAPL", "1H", [
    {
      timestamp: 3000,
      open: 3,
      high: 4,
      low: 2,
      close: 3.5,
      volume: 10,
      source: "p",
      dataStatus: "HISTORICAL",
    },
    {
      timestamp: 1000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      source: "p",
      dataStatus: "HISTORICAL",
    },
    {
      timestamp: 2000,
      open: 2,
      high: 3,
      low: 1.5,
      close: 2.5,
      volume: 10,
      source: "p",
      dataStatus: "HISTORICAL",
    },
  ]);
  const candles = db.getCandles({ symbol: "AAPL", timeframe: "1H" });
  assert.deepEqual(
    candles.map((c) => c.timestamp),
    [1000, 2000, 3000]
  );
  assert.equal(candles[0].source, "p");
  assert.equal(candles[0].dataStatus, "HISTORICAL");
});

test("candles: re-writing a bar revises it rather than duplicating", () => {
  db.upsertCandles("AAPL", "1H", [
    {
      timestamp: 3000,
      open: 3,
      high: 9,
      low: 2,
      close: 8,
      volume: 99,
      source: "p",
      dataStatus: "LIVE",
    },
  ]);
  const candles = db.getCandles({ symbol: "AAPL", timeframe: "1H" });
  assert.equal(candles.length, 3, "the revision must not create a fourth bar");
  const revised = candles.find((c) => c.timestamp === 3000);
  assert.equal(revised?.close, 8);
  assert.equal(revised?.dataStatus, "LIVE");
});

test("candles: range filters are inclusive-from and exclusive-to", () => {
  assert.deepEqual(
    db
      .getCandles({ symbol: "AAPL", timeframe: "1H", from: 2000, to: 3000 })
      .map((c) => c.timestamp),
    [2000]
  );
});

test("candles: the limit takes the NEWEST bars, still returned ascending", () => {
  assert.deepEqual(
    db.getCandles({ symbol: "AAPL", timeframe: "1H", limit: 2 }).map((c) => c.timestamp),
    [2000, 3000]
  );
});

test("candles: timeframes are stored separately", () => {
  db.upsertCandles("AAPL", "1D", [
    {
      timestamp: 1000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      source: "p",
      dataStatus: "HISTORICAL",
    },
  ]);
  assert.equal(db.getCandles({ symbol: "AAPL", timeframe: "1D" }).length, 1);
  assert.equal(db.getCandles({ symbol: "AAPL", timeframe: "1H" }).length, 3);
});

test("candles: pruning removes only bars older than the cutoff", () => {
  db.upsertCandles("PRUNE", "1H", [
    {
      timestamp: 100,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      source: "p",
      dataStatus: "HISTORICAL",
    },
    {
      timestamp: 9000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      source: "p",
      dataStatus: "HISTORICAL",
    },
  ]);
  db.deleteCandlesOlderThan(500);
  assert.deepEqual(
    db.getCandles({ symbol: "PRUNE", timeframe: "1H" }).map((c) => c.timestamp),
    [9000]
  );
});

test("risk settings: first read creates conservative defaults", () => {
  const settings = db.getRiskSettings();
  assert.equal(settings.riskPerTradeFraction, 0.01);
  assert.equal(settings.maxDailyLossFraction, 0.03);
  assert.equal(settings.maxLeverage, 2);
  assert.equal(
    settings.blockAroundHighImpactEvents,
    true,
    "blocking around high-impact events must default ON"
  );
});

test("risk settings: updates persist and leave untouched fields alone", () => {
  db.updateRiskSettings({ accountEquity: 25_000, maxLeverage: 1 });
  const settings = db.getRiskSettings();
  assert.equal(settings.accountEquity, 25_000);
  assert.equal(settings.maxLeverage, 1);
  assert.equal(settings.riskPerTradeFraction, 0.01, "unrelated fields must not be reset");
});

test("risk settings: a boolean toggle round-trips", () => {
  db.updateRiskSettings({ blockAroundHighImpactEvents: false });
  assert.equal(db.getRiskSettings().blockAroundHighImpactEvents, false);
  db.updateRiskSettings({ blockAroundHighImpactEvents: true });
  assert.equal(db.getRiskSettings().blockAroundHighImpactEvents, true);
});

test("signals: recorded with their factors so they stay explainable", () => {
  db.recordSignal({
    symbol: "AAPL",
    timeframe: "1H",
    timestamp: 5000,
    score: 72,
    state: "BUY",
    grade: "B",
    agreement: 0.7,
    regime: "trending",
    tradeable: true,
    factors: [{ id: "trend.ema_structure", value: 0.6 }],
    warnings: [],
    explanation: "WHY BUY?",
    dataStatus: "LIVE",
    source: "test",
  });
  const signals = db.getRecentSignals("AAPL");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].state, "BUY");
  assert.equal(signals[0].tradeable, true);
  assert.equal((signals[0].factors[0] as { id: string }).id, "trend.ema_structure");
});

test("journal: entries round-trip with their targets and R-multiple", () => {
  db.createJournalEntry({
    accountId: "acct-1",
    symbol: "AAPL",
    side: "long",
    openedAt: 1000,
    closedAt: 2000,
    entryPrice: 100,
    exitPrice: 110,
    stopPrice: 95,
    targetPrices: [110, 120, 130],
    quantity: 10,
    riskAmount: 50,
    netPnl: 98,
    rMultiple: 1.96,
    fees: 2,
    strategy: "breakout",
    marketRegime: "trending",
    signalScore: 78,
    notes: null,
    executionMode: "PAPER",
  });
  const entries = db.getJournalEntries("acct-1");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].targetPrices, [110, 120, 130]);
  assert.equal(entries[0].executionMode, "PAPER");
  assert.equal(entries[0].rMultiple, 1.96);
});

test("watchlists: create, update and delete", () => {
  const watchlist = db.createWatchlist("Momentum", ["AAPL", "MSFT"]);
  assert.deepEqual(watchlist.symbols, ["AAPL", "MSFT"]);

  db.updateWatchlistSymbols(watchlist.id, ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(db.listWatchlists().find((w) => w.id === watchlist.id)?.symbols, [
    "AAPL",
    "MSFT",
    "NVDA",
  ]);

  db.deleteWatchlist(watchlist.id);
  assert.equal(
    db.listWatchlists().find((w) => w.id === watchlist.id),
    undefined
  );
});

test("backtests: results are persisted with their metrics", () => {
  const id = db.recordBacktest({
    symbol: "AAPL",
    timeframe: "1D",
    fromTs: 0,
    toTs: 1000,
    initialCapital: 10_000,
    riskPerTrade: 0.01,
    commissionRate: 0.001,
    slippageRate: 0.0005,
    metrics: { netProfit: 250, winRate: 0.55 },
    trades: [],
    warnings: [],
  });
  assert.ok(id);
  const listed = db.listBacktests("AAPL");
  assert.equal(listed.length, 1);
  assert.equal((listed[0].metrics as { netProfit: number }).netProfit, 250);
});

test("orders: the same client order id cannot be inserted twice", () => {
  const insert = () =>
    getDb()
      .prepare(
        `INSERT INTO orders
           (id, account_id, client_order_id, symbol, side, type, quantity, status,
            execution_mode, created_at, updated_at)
         VALUES (?, 'acct-1', 'dup-1', 'AAPL', 'buy', 'market', 1, 'pending', 'PAPER', ?, ?)`
      )
      .run(crypto.randomUUID(), new Date().toISOString(), new Date().toISOString());

  insert();
  // Duplicate-order protection is a schema constraint, not only app logic.
  assert.throws(insert, /UNIQUE/i);
});

// ---------------------------------------------------------------------------
// Alerts and strategies
// ---------------------------------------------------------------------------

test("alerts: create, list, toggle and delete", () => {
  const alert = db.createAlert({ symbol: "AAPL", kind: "price_above", value: 200 });
  assert.equal(alert.symbol, "AAPL");
  assert.equal(alert.enabled, true);
  assert.deepEqual(alert.channels, ["browser"]);

  db.setAlertEnabled(alert.id, false);
  assert.equal(db.getAlert(alert.id)?.enabled, false);

  assert.equal(db.listAlerts("AAPL").length, 1);
  db.deleteAlert(alert.id);
  assert.equal(db.getAlert(alert.id), null);
});

test("alerts: edge-trigger state round-trips so a level rule cannot re-fire", () => {
  const alert = db.createAlert({ symbol: "MSFT", kind: "price_above", value: 100 });
  db.applyAlertStateUpdates([
    { ruleId: alert.id, lastValue: 105, lastTriggeredAt: 1_700_000_000_000 },
  ]);
  const reloaded = db.getAlert(alert.id);
  assert.equal(reloaded?.lastValue, 105);
  assert.equal(reloaded?.lastTriggeredAt, 1_700_000_000_000);
  db.deleteAlert(alert.id);
});

test("alerts: a signal_change rule persists the state it last saw", () => {
  const alert = db.createAlert({ symbol: "NVDA", kind: "signal_change" });
  db.applyAlertStateUpdates([
    { ruleId: alert.id, lastValue: null, lastTriggeredAt: null, previousState: "BUY" },
  ]);
  assert.equal(db.getAlert(alert.id)?.previousState, "BUY");
  db.deleteAlert(alert.id);
});

test("alert events: recorded, listed newest first, and acknowledgeable", () => {
  const alert = db.createAlert({ symbol: "TSLA", kind: "price_above", value: 1 });
  db.recordAlertEvents([
    {
      ruleId: alert.id,
      symbol: "TSLA",
      kind: "price_above",
      message: "older",
      observed: 2,
      threshold: 1,
      severity: "info",
      triggeredAt: 1000,
    },
    {
      ruleId: alert.id,
      symbol: "TSLA",
      kind: "price_above",
      message: "newer",
      observed: 3,
      threshold: 1,
      severity: "info",
      triggeredAt: 2000,
    },
  ]);

  const events = db.listAlertEvents(10);
  assert.equal(events[0].message, "newer");
  assert.equal(db.getAlert(alert.id)?.triggerCount, 2, "firing must bump the counter");

  assert.equal(db.listAlertEvents(10, true).length, 2);
  db.acknowledgeAlertEvents(events.map((e) => e.id));
  assert.equal(db.listAlertEvents(10, true).length, 0);
  db.deleteAlert(alert.id);
});

test("strategies: save, reload and delete a rule tree", () => {
  const definition = {
    name: "t",
    side: "long",
    entry: { all: [] },
    stop: { type: "atr", multiple: 2 },
  };
  const saved = db.saveStrategy({ name: "My strategy", definition });
  assert.equal(saved.name, "My strategy");
  assert.equal((saved.definition as { name: string }).name, "t");

  const updated = db.saveStrategy({ id: saved.id, name: "Renamed", definition });
  assert.equal(updated.id, saved.id, "saving with an id must update, not duplicate");
  assert.equal(db.listStrategies().filter((s) => s.id === saved.id).length, 1);

  db.deleteStrategy(saved.id);
  assert.equal(db.getStrategy(saved.id), null);
});

// ---------------------------------------------------------------------------
// Closing a journal entry
// ---------------------------------------------------------------------------

function openEntry(symbol: string) {
  return db.createJournalEntry({
    accountId: "paper-close",
    symbol,
    side: "long",
    openedAt: 1_000,
    closedAt: null,
    entryPrice: 100,
    exitPrice: null,
    stopPrice: 95,
    targetPrices: [110],
    quantity: 10,
    riskAmount: 50,
    netPnl: null,
    rMultiple: null,
    fees: 1.5,
    strategy: null,
    marketRegime: null,
    signalScore: null,
    notes: null,
    executionMode: "PAPER",
  });
}

test("journal: getJournalEntry reads back a single row", () => {
  const created = openEntry("READ1");
  const found = db.getJournalEntry(created.id);
  assert.ok(found);
  assert.equal(found!.symbol, "READ1");
  assert.equal(found!.closedAt, null);
  assert.deepEqual(found!.targetPrices, [110]);
});

test("journal: getJournalEntry returns null for an unknown id", () => {
  assert.equal(db.getJournalEntry("does-not-exist"), null);
});

test("journal: closing an entry records the exit, P&L and round-trip fees", () => {
  const created = openEntry("CLOSE1");
  const closed = db.closeJournalEntry(created.id, {
    closedAt: 2_000,
    exitPrice: 108,
    netPnl: 76.5,
    rMultiple: 1.53,
    fees: 3.1,
  });
  assert.ok(closed);
  assert.equal(closed!.closedAt, 2_000);
  assert.equal(closed!.exitPrice, 108);
  assert.equal(closed!.netPnl, 76.5);
  assert.equal(closed!.rMultiple, 1.53);
  assert.equal(closed!.fees, 3.1);
});

test("journal: a second close is refused, so one trade cannot be counted twice", () => {
  const created = openEntry("CLOSE2");
  const first = db.closeJournalEntry(created.id, {
    closedAt: 2_000,
    exitPrice: 108,
    netPnl: 76.5,
    rMultiple: 1.53,
    fees: 3.1,
  });
  assert.ok(first, "the first close must succeed");

  const second = db.closeJournalEntry(created.id, {
    closedAt: 3_000,
    exitPrice: 50,
    netPnl: -500,
    rMultiple: -10,
    fees: 3.1,
  });
  assert.equal(second, null, "a repeated close must be refused, not applied");

  // The original close must be untouched by the refused one.
  const stored = db.getJournalEntry(created.id);
  assert.equal(stored!.netPnl, 76.5);
  assert.equal(stored!.exitPrice, 108);
});
