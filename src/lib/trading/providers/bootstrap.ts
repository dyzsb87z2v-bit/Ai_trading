/**
 * Provider registration.
 *
 * Adapters are registered from environment configuration, once per process.
 * Importing this module is what makes a provider available — until an adapter
 * is registered AND reports itself configured, every read path reports
 * DATA SOURCE UNAVAILABLE.
 *
 * Registration is deliberately opt-in per adapter. An adapter that merely
 * exists in the codebase does not become the data source by accident.
 */

import { registerTradingProvider } from "./registry";
import { BinanceMarketDataProvider } from "./adapters/binance";

let bootstrapped = false;

/**
 * Register every adapter the environment enables. Safe to call repeatedly:
 * the registry replaces by id, and the guard makes the common case free.
 */
export function bootstrapProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // Binance public market data needs no key, so a single flag enables it.
  if (isEnabled(process.env.BINANCE_ENABLED)) {
    registerTradingProvider(
      new BinanceMarketDataProvider({
        baseUrl: process.env.BINANCE_BASE_URL?.trim() || undefined,
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
