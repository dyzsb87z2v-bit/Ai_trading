/**
 * The remaining provider adapters (§2, §13, §14, §15, §21).
 *
 * All offline: `fetch` is stubbed and no test makes a network call. What is
 * verified is the mapping and — more importantly — that every failure path
 * yields an `unavailable` result rather than a fabricated value, and that the
 * broker refuses to trade unless explicitly enabled.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TwelveDataProvider,
  parseTimeSeriesRow,
} from "@/lib/trading/providers/adapters/twelveData";
import {
  FinnhubCalendarProvider,
  FinnhubFundamentalsProvider,
  FinnhubNewsProvider,
  parseFinnhubArticle,
  parseFinnhubEvent,
  parseFinnhubMetrics,
} from "@/lib/trading/providers/adapters/finnhub";
import {
  ALPACA_LIVE_URL,
  AlpacaBrokerProvider,
  parseAlpacaOrder,
  parseAlpacaPosition,
} from "@/lib/trading/providers/adapters/alpacaBroker";
import type { FetchLike } from "@/lib/trading/providers/adapters/http";
import type { Instrument } from "@/lib/trading/types";

const AAPL: Instrument = { symbol: "AAPL", assetClass: "stock" };

function stub(handler: (url: string) => { ok?: boolean; status?: number; body: unknown } | Error): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const outcome = handler(url);
    if (outcome instanceof Error) throw outcome;
    return {
      ok: outcome.ok ?? true,
      status: outcome.status ?? 200,
      json: async () => outcome.body,
      text: async () => JSON.stringify(outcome.body),
    };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Twelve Data
// ---------------------------------------------------------------------------

const TD_ROW = {
  datetime: "2026-01-15 10:30:00",
  open: "185.20",
  high: "186.40",
  low: "184.90",
  close: "186.10",
  volume: "1234567",
};

test("twelvedata: unconfigured without a key, and says so instead of failing silently", async () => {
  const provider = new TwelveDataProvider({});
  assert.equal(provider.isConfigured(), false);
  const result = await provider.getQuote(AAPL);
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "NOT_CONFIGURED");
});

test("twelvedata: maps a time series and stamps it DELAYED, never LIVE", async () => {
  const { fetchImpl } = stub(() => ({ body: { values: [TD_ROW] } }));
  const provider = new TwelveDataProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getCandles({
    instrument: AAPL,
    timeframe: "15m",
    from: 0,
    to: Date.now(),
  });
  assert.ok(result.available);
  assert.equal(result.data.candles.length, 1);
  assert.equal(result.data.candles[0].close, 186.1);
  assert.equal(
    result.data.provenance.status,
    "DELAYED",
    "a delayed plan must never be stamped LIVE"
  );
});

test("twelvedata: a 200 response carrying an error body is a failure", async () => {
  // Twelve Data signals errors with HTTP 200 — a 200 is not proof of success.
  const { fetchImpl } = stub(() => ({
    ok: true,
    status: 200,
    body: { status: "error", message: "**symbol** not found" },
  }));
  const provider = new TwelveDataProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getCandles({
    instrument: AAPL,
    timeframe: "1H",
    from: 0,
    to: 1,
  });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.match(result.reason, /not found/);
  }
});

test("twelvedata: a rejected key never echoes the key or the URL", async () => {
  const { fetchImpl } = stub(() => ({ ok: false, status: 401, body: {} }));
  const provider = new TwelveDataProvider({ apiKey: "super-secret", fetchImpl });
  const result = await provider.getQuote(AAPL);
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "UNAUTHORIZED");
    assert.doesNotMatch(result.reason, /super-secret/);
    assert.doesNotMatch(result.reason, /twelvedata\.com/);
  }
});

test("twelvedata: a quote carries no invented bid/ask or VWAP", async () => {
  const { fetchImpl } = stub(() => ({
    body: { close: "186.10", volume: "100", percent_change: "1.23", is_market_open: true },
  }));
  const provider = new TwelveDataProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getQuote(AAPL);
  assert.ok(result.available);
  assert.equal(result.data.last, 186.1);
  assert.equal(result.data.bid, null, "the quote endpoint has no book — bid must stay null");
  assert.equal(result.data.ask, null);
  assert.equal(result.data.spread, null);
  assert.equal(result.data.vwap, null);
});

test("twelvedata: a closed market maps to closed, an unknown flag to unknown", async () => {
  for (const [flag, expected] of [
    [true, "regular"],
    [false, "closed"],
    [undefined, "unknown"],
  ] as const) {
    const { fetchImpl } = stub(() => ({ body: { close: "1", is_market_open: flag } }));
    const provider = new TwelveDataProvider({ apiKey: "k", fetchImpl });
    const result = await provider.getQuote(AAPL);
    assert.ok(result.available);
    assert.equal(result.data.session, expected);
  }
});

test("twelvedata: the 3-minute timeframe is declared approximated", () => {
  assert.equal(TwelveDataProvider.isApproximated("3m"), true);
  assert.equal(TwelveDataProvider.isApproximated("1H"), false);
});

test("parseTimeSeriesRow: volume-less forex rows are valid with volume 0", () => {
  const candle = parseTimeSeriesRow({ ...TD_ROW, volume: undefined });
  assert.ok(candle);
  assert.equal(candle!.volume, 0);
});

test("parseTimeSeriesRow: rejects impossible OHLC and unparseable dates", () => {
  assert.equal(parseTimeSeriesRow({ ...TD_ROW, high: "1", low: "9" }), null);
  assert.equal(parseTimeSeriesRow({ ...TD_ROW, datetime: "not a date" }), null);
  assert.equal(parseTimeSeriesRow(null), null);
});

// ---------------------------------------------------------------------------
// Finnhub news
// ---------------------------------------------------------------------------

const FH_ARTICLE = {
  id: 12345,
  headline: "Company reports quarterly results",
  url: "https://example.com/a",
  source: "Reuters",
  datetime: 1_768_000_000,
  related: "AAPL,MSFT",
  summary: "A summary.",
};

test("finnhub news: maps articles and sorts newest first", async () => {
  const { fetchImpl } = stub(() => ({
    body: [FH_ARTICLE, { ...FH_ARTICLE, id: 2, datetime: 1_769_000_000, headline: "Newer" }],
  }));
  const provider = new FinnhubNewsProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getNews({ symbols: ["AAPL"] });
  assert.ok(result.available);
  assert.equal(result.data[0].headline, "Newer");
  assert.deepEqual(result.data[1].symbols, ["AAPL", "MSFT"]);
});

test("finnhub news: sentiment and impact stay NULL — never locally derived", async () => {
  const { fetchImpl } = stub(() => ({ body: [FH_ARTICLE] }));
  const provider = new FinnhubNewsProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getNews({ symbols: ["AAPL"] });
  assert.ok(result.available);
  assert.equal(
    result.data[0].sentiment,
    null,
    "Finnhub does not score sentiment; deriving one would be indistinguishable from a real reading"
  );
  assert.equal(result.data[0].impact, null);
});

test("finnhub news: every request failing is an error, not an empty list", async () => {
  const { fetchImpl } = stub(() => ({ ok: false, status: 500, body: {} }));
  const provider = new FinnhubNewsProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getNews({ symbols: ["AAPL"] });
  assert.equal(result.available, false, "an all-failed fetch must not read as 'no news today'");
});

test("finnhub news: the key travels in a header, not the query string", async () => {
  const { fetchImpl, calls } = stub(() => ({ body: [] }));
  const provider = new FinnhubNewsProvider({ apiKey: "secret-key", fetchImpl });
  await provider.getNews({ symbols: ["AAPL"] });
  assert.ok(calls.length > 0);
  assert.doesNotMatch(calls[0], /secret-key/, "the key must not appear in the URL");
});

test("parseFinnhubArticle: rejects rows with no headline or no timestamp", () => {
  assert.equal(parseFinnhubArticle({ ...FH_ARTICLE, headline: "" }), null);
  assert.equal(parseFinnhubArticle({ ...FH_ARTICLE, datetime: undefined }), null);
});

// ---------------------------------------------------------------------------
// Finnhub calendar
// ---------------------------------------------------------------------------

test("finnhub calendar: maps events and filters to the window", async () => {
  const inWindow = 1_768_000_000_000;
  const { fetchImpl } = stub(() => ({
    body: {
      economicCalendar: [
        {
          event: "CPI",
          country: "US",
          time: inWindow,
          impact: "high",
          prev: "3.1",
          estimate: "3.0",
        },
        { event: "Old", country: "US", time: inWindow - 90 * 86_400_000, impact: "low" },
      ],
    },
  }));
  const provider = new FinnhubCalendarProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getEvents({
    from: inWindow - 86_400_000,
    to: inWindow + 86_400_000,
  });
  assert.ok(result.available);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].name, "CPI");
  assert.equal(result.data[0].importance, "high");
});

test("finnhub calendar: unknown importance defaults to LOW, never HIGH", () => {
  const event = parseFinnhubEvent({
    event: "X",
    country: "US",
    time: 1_768_000_000_000,
    impact: "???",
  });
  assert.ok(event);
  assert.equal(
    event!.importance,
    "low",
    "over-reporting importance would block trading around events that do not warrant it"
  );
});

test("finnhub calendar: filters by country when asked", async () => {
  const t = 1_768_000_000_000;
  const { fetchImpl } = stub(() => ({
    body: {
      economicCalendar: [
        { event: "CPI", country: "US", time: t, impact: "high" },
        { event: "GDP", country: "DE", time: t, impact: "high" },
      ],
    },
  }));
  const provider = new FinnhubCalendarProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getEvents({ from: t - 1000, to: t + 1000, countries: ["US"] });
  assert.ok(result.available);
  assert.deepEqual(
    result.data.map((e) => e.country),
    ["US"]
  );
});

// ---------------------------------------------------------------------------
// Finnhub fundamentals
// ---------------------------------------------------------------------------

test("finnhub fundamentals: a missing metric stays null, never defaulted", () => {
  const fundamentals = parseFinnhubMetrics("AAPL", { peTTM: 28.4 });
  assert.equal(fundamentals.peRatio, 28.4);
  assert.equal(fundamentals.eps, null);
  assert.equal(fundamentals.revenue, null);
  assert.equal(fundamentals.grossMargin, null);
});

test("finnhub fundamentals: a response with no metric bag is a failure", async () => {
  const { fetchImpl } = stub(() => ({ body: { symbol: "AAPL" } }));
  const provider = new FinnhubFundamentalsProvider({ apiKey: "k", fetchImpl });
  const result = await provider.getFundamentals("AAPL");
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// Alpaca broker
// ---------------------------------------------------------------------------

const creds = { apiKeyId: "id", apiSecret: "secret" };

test("broker: defaults to the PAPER host — live must be chosen deliberately", () => {
  const provider = new AlpacaBrokerProvider(creds);
  assert.equal(provider.isLiveHost, false);
  const live = new AlpacaBrokerProvider({ ...creds, baseUrl: ALPACA_LIVE_URL });
  assert.equal(live.isLiveHost, true);
});

test("broker: trading is OFF unless explicitly enabled", () => {
  assert.equal(new AlpacaBrokerProvider(creds).tradingEnabled, false);
  assert.equal(new AlpacaBrokerProvider({ ...creds, tradingEnabled: true }).tradingEnabled, true);
});

test("broker: placeOrder REFUSES while read-only, without contacting the API", async () => {
  const { fetchImpl, calls } = stub(() => ({ body: {} }));
  const provider = new AlpacaBrokerProvider({ ...creds, fetchImpl });
  const result = await provider.placeOrder({
    instrument: AAPL,
    side: "buy",
    type: "market",
    quantity: 1,
    clientOrderId: "c1",
  });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "TRADING_DISABLED");
    assert.match(result.reason, /ORDER EXECUTION DISABLED/);
  }
  assert.equal(calls.length, 0, "a refused order must never reach the broker");
});

test("broker: cancelOrder is equally gated", async () => {
  const { fetchImpl, calls } = stub(() => ({ body: {} }));
  const provider = new AlpacaBrokerProvider({ ...creds, fetchImpl });
  const result = await provider.cancelOrder("o1");
  assert.equal(result.available, false);
  assert.equal(calls.length, 0);
});

test("broker: with trading enabled an order is submitted and mapped", async () => {
  const { fetchImpl, calls } = stub(() => ({
    body: {
      id: "order-1",
      client_order_id: "c1",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      qty: "10",
      filled_qty: "0",
      status: "accepted",
      submitted_at: "2026-01-15T10:00:00Z",
      updated_at: "2026-01-15T10:00:00Z",
    },
  }));
  const provider = new AlpacaBrokerProvider({ ...creds, tradingEnabled: true, fetchImpl });
  const result = await provider.placeOrder({
    instrument: AAPL,
    side: "buy",
    type: "market",
    quantity: 10,
    clientOrderId: "c1",
  });
  assert.ok(result.available);
  assert.equal(result.data.id, "order-1");
  assert.equal(result.data.status, "open");
  assert.equal(result.data.clientOrderId, "c1", "the client id must be forwarded for dedup");
  assert.equal(calls.length, 1);
});

test("broker: an invalid order is rejected before it reaches the API", async () => {
  const { fetchImpl, calls } = stub(() => ({ body: {} }));
  const provider = new AlpacaBrokerProvider({ ...creds, tradingEnabled: true, fetchImpl });
  for (const bad of [
    { quantity: 0, type: "market" as const },
    { quantity: 5, type: "limit" as const },
    { quantity: 5, type: "stop" as const },
  ]) {
    const result = await provider.placeOrder({
      instrument: AAPL,
      side: "buy",
      clientOrderId: "c",
      ...bad,
    });
    assert.equal(result.available, false);
    if (!result.available) assert.equal(result.code, "INVALID_ORDER");
  }
  assert.equal(calls.length, 0);
});

test("broker: an unrecognised order status maps to pending, never filled", () => {
  const order = parseAlpacaOrder({
    id: "o",
    symbol: "AAPL",
    qty: "1",
    status: "some_new_status",
  });
  assert.ok(order);
  assert.equal(
    order!.status,
    "pending",
    "assuming a fill that did not happen is the most dangerous possible default"
  );
});

test("broker: reads account and positions", async () => {
  const { fetchImpl } = stub((url) =>
    url.includes("/positions")
      ? {
          body: [
            {
              symbol: "AAPL",
              qty: "10",
              avg_entry_price: "180.5",
              market_value: "1861",
              unrealized_pl: "56",
            },
          ],
        }
      : {
          body: {
            account_number: "A1",
            currency: "USD",
            equity: "100000",
            cash: "50000",
            buying_power: "200000",
          },
        }
  );
  const provider = new AlpacaBrokerProvider({ ...creds, fetchImpl });

  const account = await provider.getAccount();
  assert.ok(account.available);
  assert.equal(account.data.equity, 100000);

  const positions = await provider.getPositions();
  assert.ok(positions.available);
  assert.equal(positions.data[0].symbol, "AAPL");
  assert.equal(positions.data[0].averageEntryPrice, 180.5);
});

test("broker: rejected credentials never echo the key", async () => {
  const { fetchImpl } = stub(() => ({ ok: false, status: 403, body: {} }));
  const provider = new AlpacaBrokerProvider({
    apiKeyId: "leaky-id",
    apiSecret: "leaky",
    fetchImpl,
  });
  const result = await provider.getAccount();
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "UNAUTHORIZED");
    assert.doesNotMatch(result.reason, /leaky/);
  }
});

test("parseAlpacaPosition: rejects rows missing the essentials", () => {
  assert.equal(parseAlpacaPosition({ symbol: "AAPL" }), null);
  assert.equal(parseAlpacaPosition(null), null);
});
