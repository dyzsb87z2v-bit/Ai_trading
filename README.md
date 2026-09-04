# AI Trading Terminal

A standalone trading-analysis terminal: explainable signals, a mandatory risk
engine, look-ahead-free backtesting and paper trading.

> **What this is not.** It does not predict prices, does not guarantee outcomes,
> and does not place orders on its own. It is a decision-support and
> risk-control tool. `NO TRADE` and `WAIT` are first-class results.

Self-contained: its own Next.js app, its own SQLite database, its own auth, its
own UI. No external service is required to run it.

---

## Quick start

```bash
npm install
cp .env.example .env

# Set both values in .env:
#   AUTH_SECRET   openssl rand -base64 48
#   APP_PASSWORD  a password of your choosing
npm run dev            # http://localhost:4310
```

With no market-data provider configured the terminal runs on a clearly labelled
`SIMULATED` series so the interface is usable immediately. It never presents
that data as live — see [Demo mode](#demo-mode).

| Command                       | Does                       |
| ----------------------------- | -------------------------- |
| `npm run dev`                 | Dev server on port 4310    |
| `npm run build` / `npm start` | Production build and serve |
| `npm test`                    | 340 unit tests             |
| `npm run typecheck`           | Strict TypeScript check    |
| `npm run lint`                | ESLint                     |
| `npm run check`               | All three                  |

---

## The four rules

These are enforced by types and tests, not by convention:

| Rule                             | How                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No fabricated data               | Every market value carries `Provenance` (`source`, `timestamp`, `status`). Provider methods return `Availability<T>`, so "we don't know" is representable. The provider registry ships **empty**. |
| Stale data cannot drive a signal | `freshness.ts` is the single gate. A `LIVE` stamp past its budget degrades to `STALE`, and the pipeline refuses a tradeable verdict without it.                                                   |
| Every score is explainable       | `SignalResult.factors` carries a `ScoreFactor` per component with cited evidence. No code path emits a score without them.                                                                        |
| Risk cannot be bypassed          | `analyzeInstrument()` runs the risk engine **last** and produces the verdict itself. Callers cannot assemble a `TRADEABLE` result.                                                                |

### Data status

Never inferred, never upgraded:

`LIVE` · `DELAYED` · `HISTORICAL` · `PAPER` · `SIMULATED` · `STALE` · `UNAVAILABLE`

Only `LIVE` and `DELAYED` permit live signal generation.

---

## Pipeline

```
providers → freshness gate → indicators → structure → MTF → regime
  → signal → levels → sizing → RISK ENGINE → verdict
```

Entry point: `analyzeInstrument()` in `src/lib/trading/analysisService.ts`.
The order is the safety property — the risk engine is last and vetoes
everything above it.

| Verdict            | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `TRADEABLE`        | Every check passed, the signal cleared its threshold, a valid size exists |
| `NO_TRADE`         | Data is fine; the setup is not good enough                                |
| `BLOCKED`          | A critical risk check failed                                              |
| `DATA_UNAVAILABLE` | Data is missing or stale — nothing below is actionable                    |

---

## What's inside

| Area                             | Location                             |
| -------------------------------- | ------------------------------------ |
| Domain types, provenance         | `src/lib/trading/types.ts`           |
| Freshness gate, series integrity | `src/lib/trading/freshness.ts`       |
| Provider contracts + registry    | `src/lib/trading/providers/`         |
| Indicators                       | `src/lib/trading/indicators/`        |
| Market structure                 | `src/lib/trading/structure.ts`       |
| Multi-timeframe                  | `src/lib/trading/mtf.ts`             |
| Regime detection                 | `src/lib/trading/regime.ts`          |
| Signal + Trade Quality Score     | `src/lib/trading/signal.ts`          |
| Entry / stop / targets           | `src/lib/trading/entry.ts`           |
| Position sizing                  | `src/lib/trading/positionSizing.ts`  |
| Risk engine (13 checks)          | `src/lib/trading/riskEngine.ts`      |
| Backtester                       | `src/lib/trading/backtest.ts`        |
| Strategy Lab (rule compiler)     | `src/lib/trading/strategyLab.ts`     |
| Market scanner                   | `src/lib/trading/scanner.ts`         |
| Alert engine                     | `src/lib/trading/alerts.ts`          |
| Position monitor / reassessment  | `src/lib/trading/positionMonitor.ts` |
| Daily report packet              | `src/lib/trading/dailyReport.ts`     |
| Streaming runtime                | `src/lib/trading/streaming.ts`       |
| Paper trading                    | `src/lib/trading/paperTrading.ts`    |
| Portfolio + journal              | `src/lib/trading/portfolio.ts`       |
| Copilot evidence packet          | `src/lib/trading/copilot.ts`         |
| Orchestrator                     | `src/lib/trading/analysisService.ts` |
| Persistence                      | `src/lib/db/`                        |
| UI                               | `src/app/`, `src/components/`        |

Indicators: SMA, EMA, WMA, Wilder smoothing, RSI, MACD, Bollinger, ATR, ADX/DI,
Stochastic, CCI, ROC, realised volatility, OBV, session-anchored VWAP, volume
profile, relative volume, Fibonacci.

### Screens

| Page          | Shows                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `/terminal`   | Chart with drawing tools, watchlist, signal, levels, sizing, Copilot  |
| `/scanner`    | Rank a symbol list by setup quality; failures are listed, not dropped |
| `/alerts`     | Alert rules and their fired events                                    |
| `/strategies` | Strategy Lab presets and backtest results                             |
| `/portfolio`  | Open paper positions, exposure and correlation                        |
| `/journal`    | Closed trades, notes and statistics                                   |

Navigation is a desktop sidebar and a fixed mobile bottom bar (`AppNav.tsx`).

---

## Correctness notes

The places where a plausible implementation is wrong:

- **Wilder smoothing is not an EMA.** RSI, ATR and ADX use a `1/n` multiplier,
  not `2/(n+1)`. Conflating them is the usual cause of readings that disagree
  with every other platform.
- **MACD's signal line** is seeded from the first bar where the MACD line
  exists. Seeding at index 0 with nulls coerced to zero shifts every crossover.
- **Bollinger Bands use the population standard deviation** (÷N).
- **CCI uses mean absolute deviation**, not standard deviation.
- **VWAP is session-anchored.** A running total from the first row in the
  database is not the VWAP anyone is looking at.
- **Volume profile spreads each bar's volume across the bins its range covers**,
  proportional to overlap — not into its close bin.
- **Swings require a confirmed right side.** The newest `lookback` bars can
  never produce a swing; reporting one earlier is look-ahead bias.
- **An uptrend needs both higher highs and higher lows.** Higher highs with
  lower lows is a broadening formation.
- **Relative volume excludes the current bar** from its own baseline.
- **Position sizes round down**, and maximum loss **includes fees and slippage**.
- **Profit factor is `null`, not `Infinity`,** when nothing was lost.
- **The newest live bar is still forming.** Ageing it from its _close_ time
  would mark every live feed `STALE`; the freshness gate ages it from
  `min(closeTime, now)`. A bar whose **open** is in the future is still a fault.
- **Levels and sizing share one reference price.** The plan's own entry feeds
  the sizing call, so the two can never quote different numbers.

---

## Backtesting: how look-ahead is prevented

1. The strategy receives `candles.slice(0, i + 1)`. A future bar is unreachable
   from the callback's scope.
2. A decision on bar `i` executes at bar `i+1`'s **open**.
3. A bar touching **both** stop and target resolves as a **stop** — the bar does
   not say which came first, and assuming the favourable one manufactures profit
   that does not exist.

Slippage and half-spread always work against the fill.

---

## Strategy Lab

Strategies are a declarative rule tree (`IF` / `AND` / `OR` / `THEN`) compiled by
`compileStrategy()` into the same `Strategy` callback the backtester takes. The
tree is **data**, never code: an `eval`'d user strategy would be remote code
execution, so the compiler walks a validated AST with a depth limit instead.

`validateStrategyDefinition()` returns every issue at once, and `compileStrategy`
refuses to compile a definition with any. Five presets ship: EMA 20/50 cross,
RSI oversold reversal, trend + momentum + volume, confirmed breakout, VWAP
reclaim.

---

## Scanner

`scanMarkets()` runs the full analysis pipeline over a symbol list and ranks the
results. It classifies each into zero or more of ten setup kinds: strong trend,
breakout, momentum, volume spike, oversold, overbought, VWAP reclaim, EMA cross,
high volatility, compression.

A symbol whose data is not tradeable is ranked **below every tradeable one**
rather than dropped, and symbols that failed outright come back in
`ScanResult.failures`. A scanner that silently omits what it could not read
tells you the market is quiet when in fact your feed is down.

---

## Alerts

Fifteen alert kinds (price above/below, percent change, breakout/breakdown, RSI
bands, MACD cross, volume spike, volatility, support/resistance touch, signal
change, stop hit, target hit) across four channels: browser, email, Telegram,
push.

Alerts are **edge-triggered**: `crossedUp` / `crossedDown` return false when
there is no previous observation, so arming a rule does not immediately fire it
for a condition that was already true. The trigger state is persisted, so a
restart does not re-fire history.

`dispatchAlerts()` reports an unconfigured channel as a **failed** delivery with
the reason. An alert you believe was sent and was not is worse than no alert.

---

## Position monitoring

`monitorPosition()` tracks an open position against its plan — distance to stop
and targets, drawdown, and whether the thesis still holds. `reassessSignal()`
compares the current signal against the one that opened the position and reports
what changed.

Neither has an order path. They tell you the trade has changed; the decision
stays yours.

---

## Risk engine

`assessRisk()` runs all 13 checks and returns **every** failure, not just the
first: account, data freshness, market session, spread, volatility, position
size, daily loss, portfolio exposure, correlation, duplicate order, news event,
stop loss, risk/reward.

**Checks fail closed.** An unknown daily P&L, an unresolvable session or a
missing quote _blocks_ the trade. "We could not verify it" is not permission.

`assessLiveOrder()` adds the two live-only gates: live trading must be enabled,
and the user must have confirmed **that specific order**.

---

## AI Copilot

Optional. The Copilot decides nothing: it receives an evidence packet of values
the deterministic engines already computed and explains them.

A model asked to "analyse the chart" will invent a support level; a model handed
computed levels and told to explain them cannot, because the numbers are fixed.
Missing sections render as `UNAVAILABLE` so the model cannot fill a gap. The
daily report (`/api/report`) is built the same way.

The system prompt is prepended **server-side**, so a client cannot replace it.
Replies are audited for guaranteed-profit and fabricated-probability claims —
the audit **flags**, it does not rewrite.

Configure with `COPILOT_BASE_URL`, `COPILOT_API_KEY` and `COPILOT_MODEL` (any
OpenAI-compatible endpoint). Unset, the Copilot reports itself unavailable and
every score and level on the page is still computed.

> `SignalResult.agreement` measures how strongly the factors concur. It is
> **not** a calibrated probability of profit and must never be shown as one.

---

## Providers

Every adapter is **off by default**. `isEnabled()` accepts only `1`, `true`,
`yes` or `on`, so a stray value never quietly turns a data source on.

| Kind            | Adapter          | Env                               |
| --------------- | ---------------- | --------------------------------- |
| Market data     | Binance (crypto) | `BINANCE_ENABLED`                 |
| Market data     | Twelve Data      | `TWELVEDATA_ENABLED` + `_API_KEY` |
| News            | Finnhub          | `FINNHUB_ENABLED` + `_API_KEY`    |
| Economic events | Finnhub          | same key                          |
| Fundamentals    | Finnhub          | same key                          |
| Broker          | Alpaca           | `ALPACA_ENABLED` + key/secret     |

`getActive*Provider()` returns the first **configured** adapter — registration
alone is not enough, so a half-set-up vendor never silently becomes the source.
With nothing configured, each read path reports `DATA SOURCE UNAVAILABLE`.

### Binance

Binance's public spot endpoints need no credentials, so real prices work with a
single flag. Symbols are Binance spot pairs — `BTCUSDT`, `ETHUSDT`. **Not**
`BTCUSD`. An unknown symbol returns Binance's own error plus a hint about the
format; the adapter never rewrites a symbol, because labelling one instrument's
data with another's name is exactly the quiet corruption this project avoids.

Failure modes are distinguished rather than flattened: `RATE_LIMITED` (429),
`IP_BANNED` (418), `PROVIDER_ERROR` (Binance's own `{code,msg}`),
`NETWORK_ERROR`, `MALFORMED_RESPONSE`. Every one produces an `unavailable`
result — never a fabricated price.

`weightedAvgPrice` becomes the quote's VWAP because that is Binance's own 24h
VWAP. If the order-book call fails, bid/ask stay `null` rather than guessed.

### Twelve Data

Covers stocks, ETFs, indices, forex and crypto with one key, so it is registered
**ahead of** Binance when both are on. Twelve Data returns errors with HTTP 200
and a `status: "error"` body; the adapter reads the body, not the status code.

### Alpaca (broker)

**Read-only by default**, and points at the paper host. Three independent
switches stand between a connection and a live order — `ALPACA_ENABLED`,
`ALPACA_LIVE`, `ALPACA_TRADING_ENABLED` — and without the third the adapter
refuses every order regardless of what the caller asks for.

### Adding another

1. Implement the interface in `src/lib/trading/providers/types.ts`. Every method
   returns `Availability<T>`, and an adapter must never synthesise a value it
   did not receive upstream.
2. Call `registerTradingProvider(adapter)` at startup (see `bootstrap.ts`).

All adapters share `providers/adapters/http.ts`, which classifies transport
failures rather than collapsing them into one error.

## Streaming

`StreamRuntime` consumes `MarketDataProvider.subscribe()` with exponential
backoff (capped), batched flushes and a reconnect loop. Its clock and timers are
injected, so the tests drive reconnection deterministically without waiting.

`applyQuoteToCandle()` folds a quote into the forming bar. Volume takes the
**max**, not the sum: a quote reports the bar's cumulative volume so far, and
adding it repeatedly would inflate every live bar.

## Demo mode

`GET /api/market/series` returns a seeded, deterministic synthetic series
stamped `SIMULATED` **server-side**, so a client cannot present it as live.
Because `SIMULATED` is not a tradeable status, the freshness gate disables live
analysis and the risk engine returns `BLOCKED` — the demo **exercises** the
safety property rather than bypassing it.

It exists so the interface is usable before a real adapter is written. It is not
a data provider and must never become one.

---

## API

All routes require a session cookie.

| Route                                       | Method                | Purpose                                   |
| ------------------------------------------- | --------------------- | ----------------------------------------- |
| `/api/auth/login` · `/logout` · `/status`   | POST/POST/GET         | Session                                   |
| `/api/providers`                            | GET                   | Which providers are configured            |
| `/api/market/series`                        | GET                   | Candles + quote (real, or SIMULATED)      |
| `/api/analyze`                              | POST                  | Full pipeline + Copilot evidence packet   |
| `/api/scan`                                 | POST                  | Rank a symbol list, with failures         |
| `/api/alerts`                               | GET/POST/PATCH/DELETE | Alert rules                               |
| `/api/alerts/events`                        | GET                   | Fired alert events                        |
| `/api/alerts/evaluate`                      | POST                  | Evaluate rules against current data       |
| `/api/strategies`                           | GET/POST/DELETE       | Strategy Lab presets and definitions      |
| `/api/backtest`                             | POST                  | Backtest a preset or a compiled rule tree |
| `/api/paper`                                | GET/POST              | Paper positions: open, close, exposure    |
| `/api/journal`                              | GET/POST              | Trade journal entries                     |
| `/api/position-size`                        | POST                  | Sizing with true maximum loss             |
| `/api/risk-settings`                        | GET/PUT               | Read/update risk limits                   |
| `/api/news` · `/calendar` · `/fundamentals` | GET                   | Provider reads (UNAVAILABLE if unset)     |
| `/api/broker`                               | GET                   | Broker account/positions, read-only       |
| `/api/report`                               | POST                  | Daily report over computed evidence       |
| `/api/copilot`                              | POST                  | Model narrative over the evidence packet  |

`riskPerTradeFraction` is capped at `0.1` in the route schema as well as in the
engine. Backtests run a named preset or a **validated rule tree** — never a
user-supplied function.

---

## Security

- One local operator, one password, compared in constant time and never stored.
- Session is a signed JWT (HS256) in an `httpOnly`, `sameSite=lax` cookie.
- Without `AUTH_SECRET` the app refuses to issue sessions rather than falling
  back to a default key.
- Every page except `/login` and `/setup` is gated **server-side**, so an
  unauthenticated visitor never receives the page shell.
- Upstream errors are never echoed verbatim.
- No `eval` / `new Function` anywhere; strategies compile from an AST.

Intended for localhost or a trusted network. Put it behind TLS and a reverse
proxy before exposing it.

---

## Testing

```bash
npm test        # 340 tests
```

| File                         | Covers                                           |
| ---------------------------- | ------------------------------------------------ |
| `indicators.test.ts`         | Indicator maths against hand-derived values      |
| `risk.test.ts`               | Sizing, the 13 risk checks, the entry engine     |
| `analysis.test.ts`           | Freshness, structure, MTF, regime, signal        |
| `execution.test.ts`          | Look-ahead prevention, paper-trading P&L         |
| `portfolio-copilot.test.ts`  | Correlation, journal, evidence packet            |
| `persistence.test.ts`        | Schema and upserts on a real SQLite database     |
| `binance-adapter.test.ts`    | Adapter mapping and its whole failure taxonomy   |
| `adapters.test.ts`           | Twelve Data, Finnhub, Alpaca, shared HTTP layer  |
| `provider-bootstrap.test.ts` | A provider is never enabled by accident          |
| `strategy-lab.test.ts`       | Rule validation, compilation, depth limit        |
| `scanner-alerts.test.ts`     | Ranking, failure reporting, edge triggering      |
| `monitor-report.test.ts`     | Position monitoring, reassessment, report packet |
| `streaming.test.ts`          | Reconnect/backoff, quote folding                 |
| `orchestrator.test.ts`       | End-to-end verdicts and risk vetoes              |

Adapter tests stub `fetch` and make no network call.

---

## Not built

Stated plainly so nothing is mistaken for complete:

- **No live order submission.** The Alpaca adapter can read an account and is
  wired for orders, but trading stays refused unless three separate switches are
  set, and no UI path submits one.
- **No options, futures or on-chain data.** Spot and equities only.
- **No backtest walk-forward or parameter optimisation.** One pass, one
  parameter set.
- **No multi-user accounts, roles or audit trail.** One local operator.
- **No push/email/Telegram credentials shipped** — those alert channels report
  themselves unconfigured until you wire a dispatcher.
- **No mobile app.** The UI is responsive; it is not native.

---

## Licence

Private. Not investment advice.
