/**
 * Trading persistence.
 *
 * snake_case in SQLite, camelCase in the returned objects. Every read that
 * returns a market value also returns its `source` and `dataStatus`, so a
 * caller can never lose track of where a number came from.
 */

import { randomUUID } from "node:crypto";
import { getDb, nowIso, parseJson } from "./client";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export interface InstrumentRow {
  symbol: string;
  assetClass: string;
  exchange: string | null;
  currency: string | null;
  contractSize: number;
  tickSize: number | null;
  sector: string | null;
}

export function upsertInstrument(input: {
  symbol: string;
  assetClass: string;
  exchange?: string | null;
  currency?: string | null;
  contractSize?: number;
  tickSize?: number | null;
  sector?: string | null;
}): void {
  const timestamp = nowIso();
  getDb()
    .prepare(
      `INSERT INTO instruments
         (symbol, asset_class, exchange, currency, contract_size, tick_size, sector, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         asset_class = excluded.asset_class,
         exchange = excluded.exchange,
         currency = excluded.currency,
         contract_size = excluded.contract_size,
         tick_size = excluded.tick_size,
         sector = excluded.sector,
         updated_at = excluded.updated_at`
    )
    .run(
      input.symbol,
      input.assetClass,
      input.exchange ?? null,
      input.currency ?? null,
      input.contractSize ?? 1,
      input.tickSize ?? null,
      input.sector ?? null,
      timestamp,
      timestamp
    );
}

function mapInstrument(row: Row): InstrumentRow {
  return {
    symbol: row.symbol as string,
    assetClass: row.asset_class as string,
    exchange: (row.exchange as string | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    contractSize: (row.contract_size as number) ?? 1,
    tickSize: (row.tick_size as number | null) ?? null,
    sector: (row.sector as string | null) ?? null,
  };
}

export function getInstrument(symbol: string): InstrumentRow | null {
  const row = getDb().prepare("SELECT * FROM instruments WHERE symbol = ?").get(symbol) as
    Row | undefined;
  return row ? mapInstrument(row) : null;
}

export function listInstruments(): InstrumentRow[] {
  return (getDb().prepare("SELECT * FROM instruments ORDER BY symbol").all() as Row[]).map(
    mapInstrument
  );
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export interface StoredCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  dataStatus: string;
}

/**
 * Insert or replace bars. A forming bar is revised many times before it closes,
 * so this is last-write-wins on (symbol, timeframe, ts) — matching how a
 * streaming feed actually behaves.
 */
export function upsertCandles(
  symbol: string,
  timeframe: string,
  candles: readonly StoredCandle[]
): number {
  if (candles.length === 0) return 0;
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO candles
       (symbol, timeframe, ts, open, high, low, close, volume, source, data_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
       open = excluded.open,
       high = excluded.high,
       low = excluded.low,
       close = excluded.close,
       volume = excluded.volume,
       source = excluded.source,
       data_status = excluded.data_status`
  );
  // One transaction: 5,000 individual inserts would each pay an fsync.
  const write = db.transaction((rows: readonly StoredCandle[]) => {
    for (const c of rows) {
      statement.run(
        symbol,
        timeframe,
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        c.source,
        c.dataStatus
      );
    }
  });
  write(candles);
  return candles.length;
}

export function getCandles(params: {
  symbol: string;
  timeframe: string;
  from?: number;
  to?: number;
  limit?: number;
}): StoredCandle[] {
  const clauses = ["symbol = ?", "timeframe = ?"];
  const args: (string | number)[] = [params.symbol, params.timeframe];
  if (params.from !== undefined) {
    clauses.push("ts >= ?");
    args.push(params.from);
  }
  if (params.to !== undefined) {
    clauses.push("ts < ?");
    args.push(params.to);
  }

  // Take the NEWEST `limit` bars, then re-sort ascending: a chart wants the most
  // recent window, but every indicator needs chronological order.
  const rows = getDb()
    .prepare(`SELECT * FROM candles WHERE ${clauses.join(" AND ")} ORDER BY ts DESC LIMIT ?`)
    .all(...args, params.limit ?? 5000) as Row[];

  return rows
    .map((row) => ({
      timestamp: row.ts as number,
      open: row.open as number,
      high: row.high as number,
      low: row.low as number,
      close: row.close as number,
      volume: row.volume as number,
      source: row.source as string,
      dataStatus: row.data_status as string,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function deleteCandlesOlderThan(cutoffMs: number): number {
  return Number(getDb().prepare("DELETE FROM candles WHERE ts < ?").run(cutoffMs).changes ?? 0);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface StoredSignal {
  id: string;
  symbol: string;
  timeframe: string;
  timestamp: number;
  score: number;
  state: string;
  grade: string;
  agreement: number;
  regime: string | null;
  tradeable: boolean;
  factors: unknown[];
  warnings: unknown[];
  explanation: string | null;
  dataStatus: string;
  source: string;
  createdAt: string;
}

export function recordSignal(input: Omit<StoredSignal, "id" | "createdAt">): StoredSignal {
  const id = randomUUID();
  const createdAt = nowIso();
  getDb()
    .prepare(
      `INSERT INTO signals
         (id, symbol, timeframe, ts, score, state, grade, agreement, regime, tradeable,
          factors, warnings, explanation, data_status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.symbol,
      input.timeframe,
      input.timestamp,
      input.score,
      input.state,
      input.grade,
      input.agreement,
      input.regime,
      input.tradeable ? 1 : 0,
      JSON.stringify(input.factors),
      JSON.stringify(input.warnings),
      input.explanation,
      input.dataStatus,
      input.source,
      createdAt
    );
  return { ...input, id, createdAt };
}

export function getRecentSignals(symbol: string, limit = 50): StoredSignal[] {
  const rows = getDb()
    .prepare("SELECT * FROM signals WHERE symbol = ? ORDER BY ts DESC LIMIT ?")
    .all(symbol, limit) as Row[];
  return rows.map((row) => ({
    id: row.id as string,
    symbol: row.symbol as string,
    timeframe: row.timeframe as string,
    timestamp: row.ts as number,
    score: row.score as number,
    state: row.state as string,
    grade: row.grade as string,
    agreement: row.agreement as number,
    regime: (row.regime as string | null) ?? null,
    tradeable: row.tradeable === 1,
    factors: parseJson<unknown[]>(row.factors, []),
    warnings: parseJson<unknown[]>(row.warnings, []),
    explanation: (row.explanation as string | null) ?? null,
    dataStatus: row.data_status as string,
    source: row.source as string,
    createdAt: row.created_at as string,
  }));
}

// ---------------------------------------------------------------------------
// Risk settings
// ---------------------------------------------------------------------------

export interface StoredRiskSettings {
  id: string;
  accountEquity: number;
  riskPerTradeFraction: number;
  maxDailyLossFraction: number;
  maxPositionFraction: number;
  maxPortfolioExposureFraction: number;
  minRiskRewardRatio: number;
  maxLeverage: number;
  blockAroundHighImpactEvents: boolean;
  eventBlockWindowMinutes: number;
  updatedAt: string;
}

const RISK_SETTINGS_ID = "default";

function mapRiskSettings(row: Row): StoredRiskSettings {
  return {
    id: row.id as string,
    accountEquity: row.account_equity as number,
    riskPerTradeFraction: row.risk_per_trade_fraction as number,
    maxDailyLossFraction: row.max_daily_loss_fraction as number,
    maxPositionFraction: row.max_position_fraction as number,
    maxPortfolioExposureFraction: row.max_portfolio_exposure_fraction as number,
    minRiskRewardRatio: row.min_risk_reward_ratio as number,
    maxLeverage: row.max_leverage as number,
    blockAroundHighImpactEvents: row.block_around_high_impact_events === 1,
    eventBlockWindowMinutes: row.event_block_window_minutes as number,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Read the risk settings, materialising conservative defaults on first access.
 * An operator who has not configured limits gets the safe ones, never
 * permissive placeholders.
 */
export function getRiskSettings(): StoredRiskSettings {
  const db = getDb();
  let row = db.prepare("SELECT * FROM risk_settings WHERE id = ?").get(RISK_SETTINGS_ID) as
    Row | undefined;

  if (!row) {
    db.prepare("INSERT OR IGNORE INTO risk_settings (id, updated_at) VALUES (?, ?)").run(
      RISK_SETTINGS_ID,
      nowIso()
    );
    row = db.prepare("SELECT * FROM risk_settings WHERE id = ?").get(RISK_SETTINGS_ID) as Row;
  }
  return mapRiskSettings(row);
}

const RISK_COLUMNS: Record<string, string> = {
  accountEquity: "account_equity",
  riskPerTradeFraction: "risk_per_trade_fraction",
  maxDailyLossFraction: "max_daily_loss_fraction",
  maxPositionFraction: "max_position_fraction",
  maxPortfolioExposureFraction: "max_portfolio_exposure_fraction",
  minRiskRewardRatio: "min_risk_reward_ratio",
  maxLeverage: "max_leverage",
  blockAroundHighImpactEvents: "block_around_high_impact_events",
  eventBlockWindowMinutes: "event_block_window_minutes",
};

export function updateRiskSettings(
  updates: Partial<Omit<StoredRiskSettings, "id" | "updatedAt">>
): StoredRiskSettings {
  getRiskSettings(); // ensure the row exists

  const assignments: string[] = [];
  const args: (string | number)[] = [];
  for (const [key, column] of Object.entries(RISK_COLUMNS)) {
    const value = (updates as Record<string, unknown>)[key];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    args.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as number));
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    args.push(nowIso());
    getDb()
      .prepare(`UPDATE risk_settings SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...args, RISK_SETTINGS_ID);
  }
  return getRiskSettings();
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

export interface StoredWatchlist {
  id: string;
  name: string;
  symbols: string[];
  createdAt: string;
  updatedAt: string;
}

export function createWatchlist(name: string, symbols: readonly string[]): StoredWatchlist {
  const id = randomUUID();
  const timestamp = nowIso();
  getDb()
    .prepare(
      "INSERT INTO watchlists (id, name, symbols, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, name, JSON.stringify(symbols), timestamp, timestamp);
  return { id, name, symbols: [...symbols], createdAt: timestamp, updatedAt: timestamp };
}

export function listWatchlists(): StoredWatchlist[] {
  return (getDb().prepare("SELECT * FROM watchlists ORDER BY created_at").all() as Row[]).map(
    (row) => ({
      id: row.id as string,
      name: row.name as string,
      symbols: parseJson<string[]>(row.symbols, []),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    })
  );
}

export function updateWatchlistSymbols(id: string, symbols: readonly string[]): void {
  getDb()
    .prepare("UPDATE watchlists SET symbols = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(symbols), nowIso(), id);
}

export function deleteWatchlist(id: string): void {
  getDb().prepare("DELETE FROM watchlists WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface StoredJournalEntry {
  id: string;
  accountId: string;
  symbol: string;
  side: string;
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  stopPrice: number | null;
  targetPrices: number[];
  quantity: number;
  riskAmount: number | null;
  netPnl: number | null;
  rMultiple: number | null;
  fees: number;
  strategy: string | null;
  marketRegime: string | null;
  signalScore: number | null;
  notes: string | null;
  executionMode: string;
}

export function createJournalEntry(input: Omit<StoredJournalEntry, "id">): StoredJournalEntry {
  const id = randomUUID();
  const timestamp = nowIso();
  getDb()
    .prepare(
      `INSERT INTO journal_entries
         (id, account_id, symbol, side, opened_at, closed_at, entry_price, exit_price,
          stop_price, target_prices, quantity, risk_amount, fees, net_pnl, r_multiple,
          strategy, market_regime, signal_score, notes, execution_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.accountId,
      input.symbol,
      input.side,
      input.openedAt,
      input.closedAt,
      input.entryPrice,
      input.exitPrice,
      input.stopPrice,
      JSON.stringify(input.targetPrices),
      input.quantity,
      input.riskAmount,
      input.fees,
      input.netPnl,
      input.rMultiple,
      input.strategy,
      input.marketRegime,
      input.signalScore,
      input.notes,
      input.executionMode,
      timestamp,
      timestamp
    );
  return { ...input, id };
}

export function getJournalEntries(accountId: string, limit = 500): StoredJournalEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM journal_entries WHERE account_id = ?
       ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT ?`
    )
    .all(accountId, limit) as Row[];
  return rows.map((row) => ({
    id: row.id as string,
    accountId: row.account_id as string,
    symbol: row.symbol as string,
    side: row.side as string,
    openedAt: row.opened_at as number,
    closedAt: (row.closed_at as number | null) ?? null,
    entryPrice: row.entry_price as number,
    exitPrice: (row.exit_price as number | null) ?? null,
    stopPrice: (row.stop_price as number | null) ?? null,
    targetPrices: parseJson<number[]>(row.target_prices, []),
    quantity: row.quantity as number,
    riskAmount: (row.risk_amount as number | null) ?? null,
    netPnl: (row.net_pnl as number | null) ?? null,
    rMultiple: (row.r_multiple as number | null) ?? null,
    fees: row.fees as number,
    strategy: (row.strategy as string | null) ?? null,
    marketRegime: (row.market_regime as string | null) ?? null,
    signalScore: (row.signal_score as number | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    executionMode: row.execution_mode as string,
  }));
}

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

export function recordBacktest(input: {
  symbol: string;
  timeframe: string;
  fromTs: number;
  toTs: number;
  initialCapital: number;
  riskPerTrade: number;
  commissionRate: number;
  slippageRate: number;
  metrics: unknown;
  trades: unknown;
  warnings: unknown;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO backtests
         (id, symbol, timeframe, from_ts, to_ts, initial_capital, risk_per_trade,
          commission_rate, slippage_rate, metrics, trades, warnings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.symbol,
      input.timeframe,
      input.fromTs,
      input.toTs,
      input.initialCapital,
      input.riskPerTrade,
      input.commissionRate,
      input.slippageRate,
      JSON.stringify(input.metrics),
      JSON.stringify(input.trades),
      JSON.stringify(input.warnings),
      nowIso()
    );
  return id;
}

export interface BacktestSummary {
  id: string;
  symbol: string;
  timeframe: string;
  fromTs: number;
  toTs: number;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export function listBacktests(symbol?: string, limit = 50): BacktestSummary[] {
  const db = getDb();
  const rows = (
    symbol
      ? db
          .prepare(
            `SELECT id, symbol, timeframe, from_ts, to_ts, metrics, created_at
             FROM backtests WHERE symbol = ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(symbol, limit)
      : db
          .prepare(
            `SELECT id, symbol, timeframe, from_ts, to_ts, metrics, created_at
             FROM backtests ORDER BY created_at DESC LIMIT ?`
          )
          .all(limit)
  ) as Row[];

  return rows.map((row) => ({
    id: row.id as string,
    symbol: row.symbol as string,
    timeframe: row.timeframe as string,
    fromTs: row.from_ts as number,
    toTs: row.to_ts as number,
    metrics: parseJson<Record<string, unknown>>(row.metrics, {}),
    createdAt: row.created_at as string,
  }));
}
