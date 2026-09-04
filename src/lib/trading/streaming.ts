/**
 * Streaming runtime (master spec §3, §31, §39).
 *
 * Keeps a live view of one or more instruments, whether the provider pushes
 * (websocket) or must be polled. The spec's §3 failure list is the whole job:
 * reconnection, API failure, rate limits, stale data, duplicate events,
 * out-of-order events, missing candles and provider downtime.
 *
 * Two properties the design guarantees:
 *
 *  1. **A stalled feed becomes STALE, it does not freeze.** If no update
 *     arrives within the freshness budget the runtime emits a status change
 *     rather than leaving the last good price on screen looking current — that
 *     is the difference between "no new data" and "the price is still this".
 *
 *  2. **Updates are batched.** §31 requires the UI not re-render per tick, so
 *     subscribers are notified on a flush interval, not on every event.
 */

import { DEFAULT_FRESHNESS_POLICY, evaluateProvenance, type FreshnessPolicy } from "./freshness";
import {
  TIMEFRAME_MS,
  type Candle,
  type DataStatus,
  type Instrument,
  type Quote,
  type Timeframe,
} from "./types";

export interface StreamSnapshot {
  symbol: string;
  quote: Quote | null;
  /** The forming bar, revised in place as ticks arrive. */
  formingCandle: Candle | null;
  status: DataStatus;
  /** Age of the newest update in ms at the time of the snapshot. */
  ageMs: number;
  reason: string;
  updatedAt: number;
}

export interface StreamState {
  connected: boolean;
  /** How many reconnect attempts have been made since the last success. */
  reconnectAttempts: number;
  lastError: string | null;
  snapshots: Record<string, StreamSnapshot>;
}

export type StreamListener = (state: StreamState) => void;

export interface StreamSource {
  /** Fetch the current quote for one instrument. */
  fetchQuote(instrument: Instrument): Promise<Quote | null>;
}

export interface StreamRuntimeOptions {
  instruments: readonly Instrument[];
  timeframe: Timeframe;
  source: StreamSource;
  /** How often to poll, in ms. Ignored for push sources. */
  pollIntervalMs?: number;
  /** How often to notify subscribers. Batches ticks so the UI is not per-tick. */
  flushIntervalMs?: number;
  freshnessPolicy?: FreshnessPolicy;
  /** Reconnect backoff base; doubles per attempt up to maxBackoffMs. */
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** Injected for deterministic tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Fold a quote into the bar it belongs to.
 *
 * The forming bar is revised in place: high and low extend, close follows the
 * last trade. A quote for a bar that already closed opens a new one.
 */
export function applyQuoteToCandle(
  existing: Candle | null,
  quote: Quote,
  timeframe: Timeframe
): Candle | null {
  const price = quote.last;
  if (price === null || !Number.isFinite(price)) return existing;

  const step = TIMEFRAME_MS[timeframe];
  const bucket = Math.floor(quote.provenance.timestamp / step) * step;

  if (!existing || existing.timestamp !== bucket) {
    return {
      timestamp: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: quote.volume ?? 0,
    };
  }

  return {
    ...existing,
    high: Math.max(existing.high, price),
    low: Math.min(existing.low, price),
    close: price,
    // Provider volume is cumulative for the session, so take the max rather
    // than summing — adding every tick would multiply the true figure.
    volume: Math.max(existing.volume, quote.volume ?? existing.volume),
  };
}

export class StreamRuntime {
  private readonly options: Required<
    Pick<
      StreamRuntimeOptions,
      "pollIntervalMs" | "flushIntervalMs" | "backoffBaseMs" | "maxBackoffMs"
    >
  > &
    StreamRuntimeOptions;

  private readonly listeners = new Set<StreamListener>();
  private readonly state: StreamState;
  /** Last accepted timestamp per symbol, for out-of-order rejection. */
  private readonly lastTimestamps = new Map<string, number>();
  private pollHandle: unknown = null;
  private flushHandle: unknown = null;
  private running = false;
  private dirty = false;
  private droppedOutOfOrder = 0;
  private droppedDuplicates = 0;

  constructor(options: StreamRuntimeOptions) {
    this.options = {
      pollIntervalMs: 5_000,
      flushIntervalMs: 250,
      backoffBaseMs: 1_000,
      maxBackoffMs: 30_000,
      ...options,
    };
    this.state = {
      connected: false,
      reconnectAttempts: 0,
      lastError: null,
      snapshots: {},
    };
    for (const instrument of options.instruments) {
      this.state.snapshots[instrument.symbol] = {
        symbol: instrument.symbol,
        quote: null,
        formingCandle: null,
        status: "UNAVAILABLE",
        ageMs: 0,
        reason: "Not yet connected.",
        updatedAt: 0,
      };
    }
  }

  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshotState());
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleFlush();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    const clear = this.options.clearTimer ?? ((h: unknown) => clearTimeout(h as never));
    if (this.pollHandle !== null) clear(this.pollHandle);
    if (this.flushHandle !== null) clear(this.flushHandle);
    this.pollHandle = null;
    this.flushHandle = null;
  }

  /** Diagnostics the UI can show, so dropped events are visible not silent. */
  getDiagnostics(): { droppedOutOfOrder: number; droppedDuplicates: number } {
    return {
      droppedOutOfOrder: this.droppedOutOfOrder,
      droppedDuplicates: this.droppedDuplicates,
    };
  }

  /**
   * Ingest one quote. Public so a push source can feed the runtime directly
   * rather than being polled.
   */
  ingest(quote: Quote): void {
    const symbol = quote.instrument.symbol;
    const snapshot = this.state.snapshots[symbol];
    if (!snapshot) return;

    const previous = this.lastTimestamps.get(symbol);
    if (previous !== undefined) {
      // §3: duplicate and out-of-order events must be handled, not applied.
      if (quote.provenance.timestamp === previous) {
        this.droppedDuplicates++;
        return;
      }
      if (quote.provenance.timestamp < previous) {
        this.droppedOutOfOrder++;
        return;
      }
    }
    this.lastTimestamps.set(symbol, quote.provenance.timestamp);

    snapshot.quote = quote;
    snapshot.formingCandle = applyQuoteToCandle(
      snapshot.formingCandle,
      quote,
      this.options.timeframe
    );
    snapshot.updatedAt = this.nowMs();
    this.dirty = true;
  }

  private nowMs(): number {
    return (this.options.now ?? Date.now)();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    let anySucceeded = false;
    for (const instrument of this.options.instruments) {
      try {
        const quote = await this.options.source.fetchQuote(instrument);
        if (quote) {
          this.ingest(quote);
          anySucceeded = true;
        }
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : "fetch failed";
      }
    }

    if (anySucceeded) {
      this.state.connected = true;
      this.state.reconnectAttempts = 0;
      this.state.lastError = null;
    } else {
      // Nothing came back: treat it as a disconnect and back off.
      this.state.connected = false;
      this.state.reconnectAttempts++;
    }
    this.dirty = true;

    const delay = this.state.connected
      ? this.options.pollIntervalMs
      : this.backoffDelay(this.state.reconnectAttempts);

    const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.pollHandle = setTimer(() => void this.tick(), delay);
  }

  /** Exponential backoff, capped, so a dead provider is not hammered. */
  private backoffDelay(attempt: number): number {
    const raw = this.options.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(raw, this.options.maxBackoffMs);
  }

  private scheduleFlush(): void {
    if (!this.running) return;
    const setTimer = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.flushHandle = setTimer(() => {
      this.flush();
      this.scheduleFlush();
    }, this.options.flushIntervalMs);
  }

  /**
   * Notify subscribers. Ageing runs on every flush even when nothing arrived,
   * because a feed going quiet is itself a state change the UI must see.
   */
  flush(): void {
    const aged = this.ageSnapshots();
    if (!this.dirty && !aged) return;
    this.dirty = false;
    const state = this.snapshotState();
    for (const listener of this.listeners) listener(state);
  }

  /** Re-evaluate each snapshot's freshness. Returns true if any status changed. */
  private ageSnapshots(): boolean {
    const now = this.nowMs();
    const policy = this.options.freshnessPolicy ?? DEFAULT_FRESHNESS_POLICY;
    let changed = false;

    for (const snapshot of Object.values(this.state.snapshots)) {
      if (!snapshot.quote) continue;
      const verdict = evaluateProvenance(snapshot.quote.provenance, policy.quoteMaxAgeMs, now);
      if (snapshot.status !== verdict.status) changed = true;
      snapshot.status = verdict.status;
      snapshot.ageMs = verdict.ageMs;
      snapshot.reason = verdict.reason;
    }
    return changed;
  }

  private snapshotState(): StreamState {
    // A defensive copy: a listener must not be able to mutate runtime state.
    return {
      connected: this.state.connected,
      reconnectAttempts: this.state.reconnectAttempts,
      lastError: this.state.lastError,
      snapshots: Object.fromEntries(
        Object.entries(this.state.snapshots).map(([symbol, snapshot]) => [symbol, { ...snapshot }])
      ),
    };
  }
}
