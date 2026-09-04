/**
 * Provider registration.
 *
 * Adapters are registered from environment configuration, once per process.
 * Importing this module is what makes a provider available — until an adapter
 * is registered AND reports itself configured, every read path reports
 * DATA SOURCE UNAVAILABLE.
 *
 * Registration is opt-in per adapter. An adapter that merely exists in the
 * codebase never becomes the data source by accident, and a missing key means
 * the adapter registers but reports itself unconfigured rather than throwing at
 * startup — a half-configured vendor must not take the whole app down.
 */

import { registerTradingProvider } from "./registry";
import { BinanceMarketDataProvider } from "./adapters/binance";
import { TwelveDataProvider } from "./adapters/twelveData";
import {
  FinnhubCalendarProvider,
  FinnhubFundamentalsProvider,
  FinnhubNewsProvider,
} from "./adapters/finnhub";
import { ALPACA_LIVE_URL, ALPACA_PAPER_URL, AlpacaBrokerProvider } from "./adapters/alpacaBroker";

let bootstrapped = false;

export function bootstrapProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // --- Market data. Twelve Data is registered FIRST so it wins when both are
  // configured: it covers every asset class, Binance only crypto.
  if (isEnabled(process.env.TWELVEDATA_ENABLED)) {
    registerTradingProvider(
      new TwelveDataProvider({
        apiKey: process.env.TWELVEDATA_API_KEY,
        baseUrl: process.env.TWELVEDATA_BASE_URL?.trim() || undefined,
      })
    );
  }
  if (isEnabled(process.env.BINANCE_ENABLED)) {
    registerTradingProvider(
      new BinanceMarketDataProvider({
        baseUrl: process.env.BINANCE_BASE_URL?.trim() || undefined,
      })
    );
  }

  // --- News, calendar, fundamentals. One Finnhub key serves all three.
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const finnhubBase = process.env.FINNHUB_BASE_URL?.trim() || undefined;
  if (isEnabled(process.env.FINNHUB_ENABLED)) {
    registerTradingProvider(new FinnhubNewsProvider({ apiKey: finnhubKey, baseUrl: finnhubBase }));
    registerTradingProvider(
      new FinnhubCalendarProvider({ apiKey: finnhubKey, baseUrl: finnhubBase })
    );
    registerTradingProvider(
      new FinnhubFundamentalsProvider({ apiKey: finnhubKey, baseUrl: finnhubBase })
    );
  }

  // --- Broker. Read-only unless BOTH the connection and trading are enabled,
  // and live requires naming the live host deliberately.
  if (isEnabled(process.env.ALPACA_ENABLED)) {
    const wantsLive = isEnabled(process.env.ALPACA_LIVE);
    registerTradingProvider(
      new AlpacaBrokerProvider({
        apiKeyId: process.env.ALPACA_KEY_ID,
        apiSecret: process.env.ALPACA_SECRET,
        baseUrl:
          process.env.ALPACA_BASE_URL?.trim() || (wantsLive ? ALPACA_LIVE_URL : ALPACA_PAPER_URL),
        // Two independent flags must both be set before an order can be sent.
        tradingEnabled: isEnabled(process.env.ALPACA_TRADING_ENABLED),
      })
    );
  }
}

/** Test-only: allow a suite to re-run bootstrap after changing the env. */
export function __resetBootstrapForTest(): void {
  bootstrapped = false;
}

/**
 * Accepts the spellings people actually put in a .env file. Anything else —
 * including an empty string — is off, because a provider must never be enabled
 * by an ambiguous value.
 */
function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
