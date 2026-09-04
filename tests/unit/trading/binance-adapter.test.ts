/**
 * Binance adapter.
 *
 * Verified offline with a stubbed fetch against payloads shaped exactly like
 * Binance's documented responses. These cover the mapping AND — more
 * importantly — the failure taxonomy: every error path must produce an
 * `unavailable` result, never a fabricated price.
 *
 * Live verification against api.binance.com is a separate, manual step; this
 * suite deliberately makes no network call.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BinanceMarketDataProvider,
  parseKline,
  type FetchLike,
} from "@/lib/trading/providers/adapters/binance";
import type { Instrument } from "@/lib/trading/types";

const BTC: Instrument = { symbol: "BTCUSDT", assetClass: "crypto" };

/** A kline row in Binance's exact positional shape (all values are strings). */
const KLINE = (openTime: number, o: string, h: string, l: string, c: string, v: string) => [
  openTime,
  o,
  h,
  l,
  c,
  v,
  openTime + 3_600_000,
  "2434.19055334",
  308,
  "1756.87402397",
  "28.46694368",
  "0",
];

function stubFetch(
  handler: (url: string) => { ok?: boolean; status?: number; body: unknown } | Error
): { fetchImpl: FetchLike; calls: string[] } {
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

function provider(handler: Parameters<typeof stubFetch>[0]) {
  const { fetchImpl, calls } = stubFetch(handler);
  return { adapter: new BinanceMarketDataProvider({ fetchImpl }), calls };
}

// ---------------------------------------------------------------------------
// parseKline
// ---------------------------------------------------------------------------

test("parseKline: converts Binance's string decimals to numbers", () => {
  const candle = parseKline(
    KLINE(1_700_000_000_000, "42000.10", "42500.00", "41800.55", "42250.25", "1234.5")
  );
  assert.deepEqual(candle, {
    timestamp: 1_700_000_000_000,
    open: 42000.1,
    high: 42500,
    low: 41800.55,
    close: 42250.25,
    volume: 1234.5,
  });
});

test("parseKline: rejects a row whose high is below its low", () => {
  assert.equal(parseKline(KLINE(1, "10", "5", "9", "8", "1")), null);
});

test("parseKline: rejects short, non-array and non-numeric rows", () => {
  assert.equal(parseKline([1, "2", "3"]), null);
  assert.equal(parseKline("not an array"), null);
  assert.equal(parseKline(null), null);
  assert.equal(parseKline(KLINE(1, "abc", "5", "1", "3", "1")), null);
});

test("parseKline: rejects negative volume", () => {
  assert.equal(parseKline(KLINE(1, "10", "12", "9", "11", "-5")), null);
});

// ---------------------------------------------------------------------------
// getCandles
// ---------------------------------------------------------------------------

test("getCandles: maps a klines response into a provenance-stamped series", async () => {
  const { adapter, calls } = provider(() => ({
    body: [
      KLINE(1_700_000_000_000, "42000", "42500", "41800", "42250", "100"),
      KLINE(1_700_003_600_000, "42250", "42900", "42100", "42800", "150"),
    ],
  }));

  const result = await adapter.getCandles({
    instrument: BTC,
    timeframe: "1H",
    from: 1_700_000_000_000,
    to: 1_700_007_200_000,
    limit: 500,
  });

  assert.ok(result.available);
  assert.equal(result.data.candles.length, 2);
  assert.equal(result.data.candles[1].close, 42800);
  assert.equal(result.data.provenance.source, "binance");
  assert.equal(result.data.provenance.status, "LIVE");
  // Provenance carries the NEWEST bar's open time.
  assert.equal(result.data.provenance.timestamp, 1_700_003_600_000);
  // Our "1H" must become Binance's "1h".
  assert.match(calls[0], /interval=1h/);
  assert.match(calls[0], /symbol=BTCUSDT/);
});

test("getCandles: caps the limit at Binance's 1000-bar maximum", async () => {
  const { adapter, calls } = provider(() => ({ body: [KLINE(1, "1", "2", "0.5", "1.5", "1")] }));
  await adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 1, limit: 99_999 });
  assert.match(calls[0], /limit=1000/);
});

test("getCandles: skips malformed rows rather than inventing bars", async () => {
  const { adapter } = provider(() => ({
    body: [
      KLINE(1, "10", "12", "9", "11", "5"),
      ["garbage"],
      KLINE(2, "11", "13", "10", "12", "6"),
    ],
  }));
  const result = await adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.ok(result.available);
  assert.equal(result.data.candles.length, 2, "the corrupt row must be dropped, not repaired");
});

test("getCandles: an empty result is unavailable, not an empty success", async () => {
  const { adapter } = provider(() => ({ body: [] }));
  const result = await adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "NO_CANDLES");
});

test("getCandles: an invalid symbol surfaces Binance's own message plus a hint", async () => {
  const { adapter } = provider(() => ({
    ok: false,
    status: 400,
    body: { code: -1121, msg: "Invalid symbol." },
  }));
  const result = await adapter.getCandles({
    instrument: { symbol: "BTCUSD", assetClass: "crypto" },
    timeframe: "1H",
    from: 0,
    to: 9,
  });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.match(result.reason, /Invalid symbol/);
    assert.match(result.reason, /BTCUSDT/, "the hint must name Binance's symbol format");
  }
});

test("getCandles: rate limiting and IP bans are distinguishable", async () => {
  const limited = provider(() => ({ ok: false, status: 429, body: {} }));
  const r1 = await limited.adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.equal(r1.available, false);
  if (!r1.available) assert.equal(r1.code, "RATE_LIMITED");

  const banned = provider(() => ({ ok: false, status: 418, body: {} }));
  const r2 = await banned.adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.equal(r2.available, false);
  if (!r2.available) assert.equal(r2.code, "IP_BANNED");
});

test("getCandles: a network failure is reported, never swallowed", async () => {
  const { adapter } = provider(() => new Error("ECONNREFUSED"));
  const result = await adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.code, "NETWORK_ERROR");
    assert.match(result.reason, /ECONNREFUSED/);
  }
});

test("getCandles: a non-array payload is malformed, not empty", async () => {
  const { adapter } = provider(() => ({ body: { unexpected: true } }));
  const result = await adapter.getCandles({ instrument: BTC, timeframe: "1H", from: 0, to: 9 });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// getQuote
// ---------------------------------------------------------------------------

const TICKER = {
  symbol: "BTCUSDT",
  priceChangePercent: "2.451",
  weightedAvgPrice: "42100.50",
  lastPrice: "42250.25",
  volume: "12345.678",
  count: 987654,
  closeTime: 1_700_003_600_000,
};

const BOOK = { symbol: "BTCUSDT", bidPrice: "42250.10", askPrice: "42250.40" };

test("getQuote: maps ticker and book into one quote with a real spread", async () => {
  const { adapter } = provider((url) =>
    url.includes("bookTicker") ? { body: BOOK } : { body: TICKER }
  );
  const result = await adapter.getQuote(BTC);
  assert.ok(result.available);
  const quote = result.data;
  assert.equal(quote.last, 42250.25);
  assert.equal(quote.bid, 42250.1);
  assert.equal(quote.ask, 42250.4);
  assert.ok(Math.abs((quote.spread as number) - 0.3) < 1e-9);
  // weightedAvgPrice is Binance's own 24h VWAP, not something we computed.
  assert.equal(quote.vwap, 42100.5);
  assert.equal(quote.changePercent, 2.451);
  assert.equal(quote.tradeCount, 987654);
  assert.equal(quote.session, "regular");
  assert.equal(quote.provenance.source, "binance");
  assert.equal(quote.provenance.status, "LIVE");
  assert.equal(quote.provenance.timestamp, 1_700_003_600_000);
});

test("getQuote: a failing book leaves bid/ask null rather than guessing a spread", async () => {
  const { adapter } = provider((url) =>
    url.includes("bookTicker") ? { ok: false, status: 500, body: {} } : { body: TICKER }
  );
  const result = await adapter.getQuote(BTC);
  assert.ok(result.available, "the quote is still usable without a book");
  assert.equal(result.data.bid, null);
  assert.equal(result.data.ask, null);
  assert.equal(result.data.spread, null);
  assert.equal(result.data.last, 42250.25);
});

test("getQuote: a ticker with no price is unavailable, not a zero quote", async () => {
  const { adapter } = provider((url) =>
    url.includes("bookTicker") ? { body: BOOK } : { body: { symbol: "BTCUSDT" } }
  );
  const result = await adapter.getQuote(BTC);
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.code, "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// searchInstruments and health
// ---------------------------------------------------------------------------

test("searchInstruments: returns only TRADING pairs matching the query", async () => {
  const { adapter } = provider(() => ({
    body: {
      symbols: [
        { symbol: "BTCUSDT", status: "TRADING", quoteAsset: "USDT" },
        { symbol: "ETHUSDT", status: "TRADING", quoteAsset: "USDT" },
        { symbol: "BTCDOWNUSDT", status: "BREAK", quoteAsset: "USDT" },
      ],
    },
  }));
  const result = await adapter.searchInstruments("btc");
  assert.ok(result.available);
  assert.deepEqual(
    result.data.map((i) => i.symbol),
    ["BTCUSDT"],
    "a delisted/BREAK pair must not be offered"
  );
  assert.equal(result.data[0].assetClass, "crypto");
  assert.equal(result.data[0].exchange, "BINANCE");
});

test("health: reports reachability without pretending on failure", async () => {
  const ok = provider(() => ({ body: {} }));
  assert.equal((await ok.adapter.health()).reachable, true);

  const down = provider(() => new Error("timeout"));
  const health = await down.adapter.health();
  assert.equal(health.reachable, false);
  assert.match(health.message, /timeout/);
});

test("adapter: public market data needs no credentials", () => {
  const { adapter } = provider(() => ({ body: {} }));
  assert.equal(adapter.isConfigured(), true);
  assert.equal(adapter.descriptor.fields.length, 0);
  assert.deepEqual(adapter.supportedAssetClasses, ["crypto"]);
  assert.equal(adapter.isRealtime, true);
});
