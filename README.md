# AI Trading Terminal

A standalone trading-analysis terminal: explainable signals, a mandatory risk
engine, look-ahead-free backtesting and paper trading.

> **What this is not.** It does not predict prices, does not guarantee outcomes,
> and does not place orders. It is a decision-support and risk-control tool.
> `NO TRADE` and `WAIT` are first-class results.

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
| `npm test`                    | 220 unit tests             |
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

| Area                             | Location                                        |
| -------------------------------- | ----------------------------------------------- |
| Domain types, provenance         | `src/lib/trading/types.ts`                      |
| Freshness gate, series integrity | `src/lib/trading/freshness.ts`                  |
| Provider contracts + registry    | `src/lib/trading/providers/`                    |
| Indicators                       | `src/lib/trading/indicators/`                   |
| Market structure                 | `src/lib/trading/structure.ts`                  |
| Multi-timeframe                  | `src/lib/trading/mtf.ts`                        |
| Regime detection                 | `src/lib/trading/regime.ts`                     |
| Signal + Trade Quality Score     | `src/lib/trading/signal.ts`                     |
| Entry / stop / targets           | `src/lib/trading/entry.ts`                      |
| Position sizing                  | `src/lib/trading/positionSizing.ts`             |
| Risk engine (13 checks)          | `src/lib/trading/riskEngine.ts`                 |
| Backtester                       | `src/lib/trading/backtest.ts`                   |
| Paper trading                    | `src/lib/trading/paperTrading.ts`               |
| Portfolio + journal              | `src/lib/trading/portfolio.ts`                  |
| Copilot evidence packet          | `src/lib/trading/copilot.ts`                    |
| Orchestrator                     | `src/lib/trading/analysisService.ts`            |
| Persistence                      | `src/lib/db/`                                   |
| UI                               | `src/app/terminal/`, `src/components/terminal/` |

Indicators: SMA, EMA, WMA, Wilder smoothing, RSI, MACD, Bollinger, ATR, ADX/DI,
Stochastic, CCI, ROC, realised volatility, OBV, session-anchored VWAP, volume
profile, relative volume, Fibonacci.

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
Missing sections render as `UNAVAILABLE` so the model cannot fill a gap.

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

### Binance (included, no API key)

The one shipped adapter. Binance's public spot market-data endpoints need no
credentials, so real prices work with a single flag:

```bash
BINANCE_ENABLED=true
```

Symbols are Binance spot pairs — `BTCUSDT`, `ETHUSDT`. **Not** `BTCUSD`. An
unknown symbol returns Binance's own error plus a hint about the format; the
adapter never rewrites a symbol, because labelling one instrument's data with
another's name is exactly the quiet corruption this project avoids.

Failure modes are distinguished rather than flattened: `RATE_LIMITED` (429),
`IP_BANNED` (418), `PROVIDER_ERROR` (Binance's own `{code,msg}`),
`NETWORK_ERROR`, `MALFORMED_RESPONSE`. Every one produces an `unavailable`
result — never a fabricated price.

`weightedAvgPrice` becomes the quote's VWAP because that is Binance's own 24h
VWAP. If the order-book call fails, bid/ask stay `null` rather than guessed.

Its unit tests stub `fetch` and make no network call.

### Adding another

Every other provider kind — news, fundamentals, economic calendar, broker —
ships unregistered, so those read paths report `DATA SOURCE UNAVAILABLE`.

To add one:

1. Implement the interface in `src/lib/trading/providers/types.ts`. Every method
   returns `Availability<T>`, and an adapter must never synthesise a value it
   did not receive upstream.
2. Call `registerTradingProvider(adapter)` at startup.

`getActive*Provider()` returns the first **configured** adapter — registration
alone is not enough, so a half-set-up vendor never silently becomes the source.

**Broker adapters are read-only by default.** Live execution stays off unless an
operator turns it on.

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

| Route                                     | Method        | Purpose                                  |
| ----------------------------------------- | ------------- | ---------------------------------------- |
| `/api/auth/login` · `/logout` · `/status` | POST/POST/GET | Session                                  |
| `/api/providers`                          | GET           | Which providers are configured           |
| `/api/market/series`                      | GET           | Candles + quote (real, or SIMULATED)     |
| `/api/analyze`                            | POST          | Full pipeline + Copilot evidence packet  |
| `/api/position-size`                      | POST          | Sizing with true maximum loss            |
| `/api/risk-settings`                      | GET/PUT       | Read/update risk limits                  |
| `/api/backtest`                           | POST          | Backtest a named built-in strategy       |
| `/api/copilot`                            | POST          | Model narrative over the evidence packet |

`riskPerTradeFraction` is capped at `0.1` in the route schema as well as in the
engine. Backtest strategies are chosen from a fixed named set — an endpoint that
`eval`'d a user-supplied strategy would be remote code execution.

---

## Security

- One local operator, one password, compared in constant time and never stored.
- Session is a signed JWT (HS256) in an `httpOnly`, `sameSite=lax` cookie.
- Without `AUTH_SECRET` the app refuses to issue sessions rather than falling
  back to a default key.
- `/terminal` is gated **server-side**, so an unauthenticated visitor never
  receives the page shell.
- Upstream errors are never echoed verbatim.

Intended for localhost or a trusted network. Put it behind TLS and a reverse
proxy before exposing it.

---

## Testing

```bash
npm test        # 220 tests
```

| File                         | Covers                                         |
| ---------------------------- | ---------------------------------------------- |
| `indicators.test.ts`         | Indicator maths against hand-derived values    |
| `risk.test.ts`               | Sizing, the 13 risk checks, the entry engine   |
| `analysis.test.ts`           | Freshness, structure, MTF, regime, signal      |
| `execution.test.ts`          | Look-ahead prevention, paper-trading P&L       |
| `portfolio-copilot.test.ts`  | Correlation, journal, evidence packet          |
| `persistence.test.ts`        | Schema and upserts on a real SQLite database   |
| `binance-adapter.test.ts`    | Adapter mapping and its whole failure taxonomy |
| `provider-bootstrap.test.ts` | A provider is never enabled by accident        |
| `orchestrator.test.ts`       | End-to-end verdicts and risk vetoes            |

---

## Not built

Stated plainly so nothing is mistaken for complete:

- **Only one market-data adapter** (Binance, crypto spot). No stocks, forex,
  news, fundamentals, economic-calendar or broker adapters.
- **No streaming runtime.** `MarketDataProvider.subscribe()` is defined but no
  reconnect/backpressure loop consumes it.
- **No market scanner**, no chart drawing tools.
- **No paper-trading or journal UI.** Both engines exist and are tested; neither
  has a screen yet.
- **No broker adapters** and no live order submission path.
- **No alerts**, no news or economic-calendar adapters.

---

## Licence

Private. Not investment advice.
