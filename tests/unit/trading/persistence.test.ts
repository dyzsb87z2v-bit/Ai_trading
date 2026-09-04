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
