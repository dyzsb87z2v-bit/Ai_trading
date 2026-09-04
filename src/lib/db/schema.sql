-- Trading terminal schema.
--
-- Time-series tables are keyed on their natural query shape ("bars for symbol X
-- on timeframe Y between t0 and t1"), so the primary key IS the range index and
-- a scan never touches a second structure.
--
-- Every table holding a market-dependent value also stores its provenance
-- (source + data_status). A row without it cannot be trusted later.

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  symbol TEXT PRIMARY KEY,
  asset_class TEXT NOT NULL,
  exchange TEXT,
  currency TEXT,
  contract_size REAL NOT NULL DEFAULT 1,
  tick_size REAL,
  sector TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instruments_asset_class ON instruments(asset_class);

CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,               -- bar OPEN time, epoch ms, UTC
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  data_status TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  ts INTEGER NOT NULL,
  score REAL NOT NULL,
  state TEXT NOT NULL,
  grade TEXT NOT NULL,
  agreement REAL NOT NULL,
  regime TEXT,
  tradeable INTEGER NOT NULL DEFAULT 0,
  factors TEXT NOT NULL DEFAULT '[]',   -- kept so a past signal stays explainable
  warnings TEXT NOT NULL DEFAULT '[]',
  explanation TEXT,
  data_status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_ts ON signals(symbol, ts DESC);

CREATE TABLE IF NOT EXISTS risk_settings (
  id TEXT PRIMARY KEY,
  account_equity REAL NOT NULL DEFAULT 0,
  risk_per_trade_fraction REAL NOT NULL DEFAULT 0.01,
  max_daily_loss_fraction REAL NOT NULL DEFAULT 0.03,
  max_position_fraction REAL NOT NULL DEFAULT 0.2,
  max_portfolio_exposure_fraction REAL NOT NULL DEFAULT 1,
  min_risk_reward_ratio REAL NOT NULL DEFAULT 1.5,
  max_leverage REAL NOT NULL DEFAULT 2,
  block_around_high_impact_events INTEGER NOT NULL DEFAULT 1,
  event_block_window_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbols TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'paper',   -- 'paper' | 'live'
  currency TEXT NOT NULL DEFAULT 'USD',
  initial_capital REAL NOT NULL DEFAULT 0,
  cash REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  status TEXT NOT NULL,
  filled_quantity REAL NOT NULL DEFAULT 0,
  average_fill_price REAL,
  fees REAL NOT NULL DEFAULT 0,
  reject_reason TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER',  -- PAPER and LIVE never conflated
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at DESC);
-- Duplicate-order protection enforced in the schema, not only in code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_id
  ON orders(account_id, client_order_id) WHERE client_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  average_entry_price REAL NOT NULL,
  stop_price REAL,
  take_profit_price REAL,
  opened_at INTEGER NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_account_symbol
  ON positions(account_id, symbol);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  entry_price REAL NOT NULL,
  exit_price REAL,
  stop_price REAL,
  target_prices TEXT NOT NULL DEFAULT '[]',
  quantity REAL NOT NULL,
  risk_amount REAL,
  reward_amount REAL,
  fees REAL NOT NULL DEFAULT 0,
  net_pnl REAL,
  r_multiple REAL,
  strategy TEXT,
  market_regime TEXT,
  signal_score REAL,
  ai_analysis TEXT,
  notes TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_account_closed
  ON journal_entries(account_id, closed_at DESC);

CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  initial_capital REAL NOT NULL,
  risk_per_trade REAL NOT NULL,
  commission_rate REAL NOT NULL DEFAULT 0,
  slippage_rate REAL NOT NULL DEFAULT 0,
  metrics TEXT NOT NULL DEFAULT '{}',
  trades TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backtests_symbol ON backtests(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  trading_enabled INTEGER NOT NULL DEFAULT 0,  -- live execution OFF by default
  last_health_at INTEGER,
  last_health_ok INTEGER,
  last_health_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_kind_provider
  ON provider_connections(kind, provider_id);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  value REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  channels TEXT NOT NULL DEFAULT '["browser"]',
  cooldown_ms INTEGER,
  -- Edge-triggering state: without these a level rule would re-fire forever.
  last_value REAL,
  previous_state TEXT,
  last_triggered_at INTEGER,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol, enabled);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  observed REAL,
  threshold REAL,
  severity TEXT NOT NULL DEFAULT 'info',
  triggered_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_events_triggered
  ON alert_events(triggered_at DESC);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- Serialised rule tree from the Strategy Lab. Never executable code.
  definition TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
