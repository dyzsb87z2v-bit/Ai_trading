/**
 * Streaming runtime (§3, §31).
 *
 * The spec's §3 failure list is the test list: reconnection, API failure,
 * stale data, duplicate events, out-of-order events. Timers and the clock are
 * injected so none of this depends on wall time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { StreamRuntime, applyQuoteToCandle, type StreamState } from "@/lib/trading/streaming";
import type { Instrument, Quote } from "@/lib/trading/types";

const AAPL: Instrument = { symbol: "AAPL", assetClass: "stock" };

function quote(last: number, timestamp: number, volume = 1000): Quote {
  return {
    instrument: AAPL,
    last,
    bid: last - 0.01,
    ask: last + 0.01,
    spread: 0.02,
    volume,
    tradeCount: 10,
    vwap: last,
    changePercent: 0,
    session: "regular",
    provenance: { source: "test", timestamp, status: "LIVE" },
  };
}

/** A controllable clock and timer queue so tests are deterministic. */
function harness() {
  let now = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const timer of due) timers.splice(timers.indexOf(timer), 1);
      for (const timer of due) timer.fn();
    },
    setTimer: (fn: () => void, ms: number) => {
      const handle = { fn, at: now + ms };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as never);
      if (index >= 0) timers.splice(index, 1);
    },
    pending: () => timers.length,
  };
}

// ---------------------------------------------------------------------------
// Candle folding
// ---------------------------------------------------------------------------

test("candle folding: the first quote opens the bar", () => {
  const candle = applyQuoteToCandle(null, quote(100, 3_600_000), "1H");
  assert.ok(candle);
  assert.equal(candle!.timestamp, 3_600_000);
  assert.equal(candle!.open, 100);
  assert.equal(candle!.high, 100);
  assert.equal(candle!.low, 100);
  assert.equal(candle!.close, 100);
});

test("candle folding: later quotes extend high/low and move the close", () => {
  let candle = applyQuoteToCandle(null, quote(100, 3_600_000), "1H");
  candle = applyQuoteToCandle(candle, quote(105, 3_600_100), "1H");
  candle = applyQuoteToCandle(candle, quote(98, 3_600_200), "1H");
  assert.equal(candle!.open, 100, "the open must never move");
  assert.equal(candle!.high, 105);
  assert.equal(candle!.low, 98);
  assert.equal(candle!.close, 98);
});

test("candle folding: crossing the bar boundary opens a NEW bar", () => {
  let candle = applyQuoteToCandle(null, quote(100, 3_600_000), "1H");
  candle = applyQuoteToCandle(candle, quote(110, 7_200_001), "1H");
  assert.equal(candle!.timestamp, 7_200_000);
  assert.equal(candle!.open, 110, "a new bar opens at the first price of that bar");
});

test("candle folding: cumulative volume is taken as a max, not summed", () => {
  let candle = applyQuoteToCandle(null, quote(100, 3_600_000, 500), "1H");
  candle = applyQuoteToCandle(candle, quote(101, 3_600_100, 900), "1H");
  assert.equal(candle!.volume, 900, "summing cumulative volume would multiply the true figure");
});

test("candle folding: a quote with no price leaves the bar untouched", () => {
  const first = applyQuoteToCandle(null, quote(100, 3_600_000), "1H");
  const noPrice = { ...quote(0, 3_600_100), last: null };
  assert.deepEqual(applyQuoteToCandle(first, noPrice, "1H"), first);
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

test("runtime: ingesting a quote produces a snapshot on flush", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  const states: StreamState[] = [];
  runtime.subscribe((state) => states.push(state));
  runtime.ingest(quote(100, h.now()));
  runtime.flush();

  const latest = states[states.length - 1];
  assert.equal(latest.snapshots.AAPL.quote?.last, 100);
  assert.equal(latest.snapshots.AAPL.formingCandle?.close, 100);
  runtime.stop();
});

test("runtime: a duplicate timestamp is DROPPED and counted", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  runtime.ingest(quote(100, 5_000));
  runtime.ingest(quote(999, 5_000)); // same timestamp, different price
  runtime.flush();

  let seen: StreamState | null = null;
  runtime.subscribe((s) => {
    seen = s;
  });
  assert.equal(seen!.snapshots.AAPL.quote?.last, 100, "the duplicate must not overwrite");
  assert.equal(runtime.getDiagnostics().droppedDuplicates, 1);
  runtime.stop();
});

test("runtime: an out-of-order quote is DROPPED and counted", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  runtime.ingest(quote(100, 10_000));
  runtime.ingest(quote(50, 9_000)); // older
  let seen: StreamState | null = null;
  runtime.subscribe((s) => {
    seen = s;
  });
  assert.equal(seen!.snapshots.AAPL.quote?.last, 100);
  assert.equal(runtime.getDiagnostics().droppedOutOfOrder, 1);
  runtime.stop();
});

test("runtime: a feed that goes quiet becomes STALE rather than looking current", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    flushIntervalMs: 100,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  const states: StreamState[] = [];
  runtime.subscribe((s) => states.push(s));
  runtime.ingest(quote(100, h.now()));
  runtime.flush();
  assert.equal(states[states.length - 1].snapshots.AAPL.status, "LIVE");

  // Let the quote age past the 15s freshness budget without a new tick.
  h.advance(60_000);
  runtime.flush();
  assert.equal(
    states[states.length - 1].snapshots.AAPL.status,
    "STALE",
    "a quiet feed must not leave the last price looking current"
  );
  runtime.stop();
});

test("runtime: updates are BATCHED — many ticks, one notification per flush", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  let notifications = 0;
  runtime.subscribe(() => notifications++);
  const initial = notifications; // subscribe emits once

  for (let i = 1; i <= 50; i++) runtime.ingest(quote(100 + i, 5_000 + i));
  assert.equal(notifications, initial, "ingesting must not notify per tick");

  runtime.flush();
  assert.equal(notifications, initial + 1, "one flush is one notification");
  runtime.stop();
});

test("runtime: flush is a no-op when nothing changed", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  let notifications = 0;
  runtime.subscribe(() => notifications++);
  const initial = notifications;
  runtime.flush();
  runtime.flush();
  assert.equal(notifications, initial);
  runtime.stop();
});

test("runtime: a failing source backs off exponentially, capped", async () => {
  const h = harness();
  const delays: number[] = [];
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: {
      fetchQuote: async () => {
        throw new Error("provider down");
      },
    },
    backoffBaseMs: 1_000,
    maxBackoffMs: 8_000,
    now: h.now,
    setTimer: (fn, ms) => {
      delays.push(ms);
      return h.setTimer(fn, ms);
    },
    clearTimer: h.clearTimer,
  });

  runtime.start();
  // Let several failed cycles run.
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    h.advance(20_000);
    await Promise.resolve();
  }
  runtime.stop();

  // Poll delays should grow then plateau at the cap.
  const pollDelays = delays.filter((d) => d >= 1_000);
  assert.ok(pollDelays.length >= 2, `expected several backoff delays, got ${pollDelays.length}`);
  assert.ok(Math.max(...pollDelays) <= 8_000, "backoff must be capped");
});

test("runtime: a recovering source resets the reconnect counter", async () => {
  const h = harness();
  let fail = true;
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: {
      fetchQuote: async () => {
        if (fail) throw new Error("down");
        return quote(100, h.now());
      },
    },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });

  let latest: StreamState | null = null;
  runtime.subscribe((s) => {
    latest = s;
  });
  runtime.start();
  await Promise.resolve();
  h.advance(5_000);
  await Promise.resolve();
  runtime.flush();
  assert.equal(latest!.connected, false);
  assert.ok(latest!.reconnectAttempts > 0);

  fail = false;
  h.advance(20_000);
  await Promise.resolve();
  await Promise.resolve();
  runtime.flush();
  assert.equal(latest!.connected, true);
  assert.equal(latest!.reconnectAttempts, 0, "a success must reset the counter");
  runtime.stop();
});

test("runtime: stop cancels its timers", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  runtime.start();
  const before = h.pending();
  runtime.stop();
  assert.ok(h.pending() < before || before === 0);
});

test("runtime: a listener cannot mutate runtime state", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  runtime.ingest(quote(100, h.now()));
  let captured: StreamState | null = null;
  runtime.subscribe((s) => {
    captured = s;
  });
  captured!.snapshots.AAPL.status = "LIVE";
  captured!.snapshots.AAPL.quote = null;

  let second: StreamState | null = null;
  runtime.subscribe((s) => {
    second = s;
  });
  assert.equal(second!.snapshots.AAPL.quote?.last, 100, "state must be defensively copied");
  runtime.stop();
});

test("runtime: an unknown symbol's quote is ignored rather than creating a slot", () => {
  const h = harness();
  const runtime = new StreamRuntime({
    instruments: [AAPL],
    timeframe: "1H",
    source: { fetchQuote: async () => null },
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
  });
  runtime.ingest({ ...quote(100, h.now()), instrument: { symbol: "OTHER", assetClass: "stock" } });
  let latest: StreamState | null = null;
  runtime.subscribe((s) => {
    latest = s;
  });
  assert.equal(Object.keys(latest!.snapshots).length, 1);
  assert.equal(latest!.snapshots.OTHER, undefined);
  runtime.stop();
});
