/**
 * Provider bootstrap.
 *
 * The property under test is that a provider is never enabled by accident: an
 * adapter that exists in the codebase must not become the data source until the
 * environment explicitly turns it on.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { bootstrapProviders, __resetBootstrapForTest } from "@/lib/trading/providers/bootstrap";
import {
  __resetTradingProvidersForTest,
  getActiveMarketDataProvider,
  summarizeProviders,
} from "@/lib/trading/providers/registry";

afterEach(() => {
  __resetTradingProvidersForTest();
  __resetBootstrapForTest();
  delete process.env.BINANCE_ENABLED;
});

test("bootstrap: no provider is registered by default", () => {
  bootstrapProviders();
  assert.equal(getActiveMarketDataProvider(), null);
  const marketData = summarizeProviders().find((p) => p.kind === "market-data");
  assert.equal(marketData?.registered, 0);
  assert.match(marketData?.unavailableMessage ?? "", /DATA SOURCE UNAVAILABLE/);
});

test("bootstrap: BINANCE_ENABLED registers the adapter", () => {
  process.env.BINANCE_ENABLED = "true";
  bootstrapProviders();
  const active = getActiveMarketDataProvider();
  assert.ok(active, "the adapter should be active once enabled");
  assert.equal(active?.descriptor.id, "binance");
});

test("bootstrap: accepts the spellings people actually write", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    process.env.BINANCE_ENABLED = value;
    bootstrapProviders();
    assert.ok(getActiveMarketDataProvider(), `"${value}" should enable the adapter`);
    __resetTradingProvidersForTest();
    __resetBootstrapForTest();
  }
});

test("bootstrap: an ambiguous or empty value leaves the provider off", () => {
  for (const value of ["", "0", "false", "no", "maybe", " "]) {
    process.env.BINANCE_ENABLED = value;
    bootstrapProviders();
    assert.equal(getActiveMarketDataProvider(), null, `"${value}" must not enable the adapter`);
    __resetTradingProvidersForTest();
    __resetBootstrapForTest();
  }
});

test("bootstrap: calling twice does not double-register", () => {
  process.env.BINANCE_ENABLED = "true";
  bootstrapProviders();
  bootstrapProviders();
  assert.equal(summarizeProviders().find((p) => p.kind === "market-data")?.registered, 1);
});
