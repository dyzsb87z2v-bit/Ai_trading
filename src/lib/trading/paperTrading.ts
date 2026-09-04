/**
 * Paper trading engine (master spec §20).
 *
 * Simulated execution against REAL market data. The two are never conflated:
 * every account, order and position produced here carries `mode: "PAPER"`, and
 * fills are stamped SIMULATED even though the prices driving them are LIVE.
 *
 * Fill rules mirror the backtester so a strategy behaves consistently:
 *  - Market orders fill at the current quote's far touch (ask to buy, bid to
 *    sell), plus slippage. Filling at the mid would flatter every result.
 *  - Limit orders fill only when the market trades through the limit.
 *  - Stop orders become market orders once triggered, and so pay slippage.
 */

import type { CostModel } from "./positionSizing";
import { DEFAULT_COST_MODEL } from "./positionSizing";
import type { OrderType } from "./providers/types";
import type { Quote, Side } from "./types";

export type PaperOrderStatus = "pending" | "filled" | "cancelled" | "rejected";

export interface PaperOrder {
  id: string;
  mode: "PAPER";
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  status: PaperOrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  fees: number;
  createdAt: number;
  updatedAt: number;
  rejectReason: string | null;
}

export interface PaperPosition {
  mode: "PAPER";
  symbol: string;
  side: Side;
  quantity: number;
  averageEntryPrice: number;
  openedAt: number;
  realizedPnl: number;
}

export interface PaperAccountState {
  mode: "PAPER";
  currency: string;
  initialCapital: number;
  cash: number;
  /** Cash plus the mark-to-market value of open positions. */
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalFees: number;
  peakEquity: number;
  maxDrawdown: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  /** Marks used for the last valuation, for auditability. */
  lastMarkedAt: number | null;
}

export interface PaperEngineOptions {
  initialCapital: number;
  currency?: string;
  costs?: CostModel;
  contractSize?: number;
  /** Injected so tests are deterministic. */
  now?: () => number;
  idFactory?: () => string;
}

export interface SubmitOrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
}

/**
 * An in-memory paper account. Persistence is the caller's concern — this class
 * is deliberately pure so it can be unit-tested and replayed.
 */
export class PaperTradingEngine {
  private readonly costs: CostModel;
  private readonly contractSize: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private sequence = 0;

  private cash: number;
  private readonly initialCapital: number;
  private readonly currency: string;
  private realizedPnl = 0;
  private totalFees = 0;
  private peakEquity: number;
  private maxDrawdown = 0;
  private lastMarkedAt: number | null = null;

  private readonly positions = new Map<string, PaperPosition>();
  private readonly orders: PaperOrder[] = [];
  private readonly marks = new Map<string, number>();

  constructor(options: PaperEngineOptions) {
    if (options.initialCapital <= 0) {
      throw new RangeError("Paper account initial capital must be positive");
    }
    this.initialCapital = options.initialCapital;
    this.cash = options.initialCapital;
    this.peakEquity = options.initialCapital;
    this.currency = options.currency ?? "USD";
    this.costs = options.costs ?? DEFAULT_COST_MODEL;
    this.contractSize = options.contractSize ?? 1;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `paper-${++this.sequence}`);
  }

  /**
   * Restore a position the caller already holds, without treating it as a new
   * fill.
   *
   * The app is stateless between requests, so closing a position that was
   * opened by an earlier request means rebuilding the book first. Replaying the
   * opening ORDER would be wrong: the stored entry price is already the filled
   * price, so re-submitting it would cross the spread and charge commission a
   * second time. Seeding restores the position as it stands and lets the
   * closing order — and only the closing order — pay the exit costs.
   */
  seedPosition(input: {
    symbol: string;
    side: Side;
    quantity: number;
    averageEntryPrice: number;
    openedAt: number;
    realizedPnl?: number;
  }): void {
    if (input.quantity <= 0 || !Number.isFinite(input.quantity)) {
      throw new RangeError("Seeded position quantity must be positive");
    }
    if (input.averageEntryPrice <= 0 || !Number.isFinite(input.averageEntryPrice)) {
      throw new RangeError("Seeded position entry price must be positive");
    }
    if (this.positions.has(input.symbol)) {
      throw new Error(`A position for ${input.symbol} already exists`);
    }
    this.positions.set(input.symbol, {
      mode: "PAPER",
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      averageEntryPrice: input.averageEntryPrice,
      openedAt: input.openedAt,
      realizedPnl: input.realizedPnl ?? 0,
    });
    // Mark at the entry price so equity reads flat until a real quote arrives.
    // Leaving it unmarked would report the position as worth nothing.
    this.marks.set(input.symbol, input.averageEntryPrice);
  }

  /**
   * Submit an order. Market orders attempt an immediate fill against `quote`;
   * limit and stop orders rest until `processQuote` triggers them.
   *
   * A market order without a usable quote is REJECTED, never filled at a guessed
   * price — that would be fabricating a trade (§32).
   */
  submitOrder(input: SubmitOrderInput, quote: Quote | null): PaperOrder {
    const timestamp = this.now();
    const order: PaperOrder = {
      id: this.idFactory(),
      mode: "PAPER",
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      limitPrice: input.limitPrice ?? null,
      stopPrice: input.stopPrice ?? null,
      status: "pending",
      filledQuantity: 0,
      averageFillPrice: null,
      fees: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      rejectReason: null,
    };

    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      order.status = "rejected";
      order.rejectReason = "Quantity must be a positive number.";
      this.orders.push(order);
      return order;
    }
    if (input.type === "limit" && !Number.isFinite(input.limitPrice ?? NaN)) {
      order.status = "rejected";
      order.rejectReason = "A limit order requires a limit price.";
      this.orders.push(order);
      return order;
    }
    if (input.type === "stop" && !Number.isFinite(input.stopPrice ?? NaN)) {
      order.status = "rejected";
      order.rejectReason = "A stop order requires a stop price.";
      this.orders.push(order);
      return order;
    }

    this.orders.push(order);

    if (input.type === "market") {
      if (!quote) {
        order.status = "rejected";
        order.rejectReason = "DATA SOURCE UNAVAILABLE — no quote to fill against.";
        return order;
      }
      const price = this.marketFillPrice(quote, input.side);
      if (price === null) {
        order.status = "rejected";
        order.rejectReason = "Quote carries no usable price.";
        return order;
      }
      this.fill(order, price, quote.provenance.timestamp);
    } else if (quote) {
      this.tryTriggerRestingOrder(order, quote);
    }

    return order;
  }

  /** Advance the account with a new quote: trigger resting orders, then mark. */
  processQuote(quote: Quote): void {
    for (const order of this.orders) {
      if (order.status === "pending" && order.symbol === quote.instrument.symbol) {
        this.tryTriggerRestingOrder(order, quote);
      }
    }
    const mark = quote.last ?? midPrice(quote);
    if (mark !== null) {
      this.marks.set(quote.instrument.symbol, mark);
      this.lastMarkedAt = quote.provenance.timestamp;
    }
    this.updateDrawdown();
  }

  cancelOrder(orderId: string): PaperOrder | null {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order || order.status !== "pending") return null;
    order.status = "cancelled";
    order.updatedAt = this.now();
    return order;
  }

  getState(): PaperAccountState {
    const positions = [...this.positions.values()];
    const unrealizedPnl = positions.reduce(
      (sum, position) => sum + this.positionUnrealized(position),
      0
    );
    return {
      mode: "PAPER",
      currency: this.currency,
      initialCapital: this.initialCapital,
      cash: this.cash,
      equity: this.cash + unrealizedPnl,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      totalFees: this.totalFees,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      positions,
      orders: [...this.orders],
      lastMarkedAt: this.lastMarkedAt,
    };
  }

  // -------------------------------------------------------------------------

  private marketFillPrice(quote: Quote, side: "buy" | "sell"): number | null {
    // Cross the spread: buy at the ask, sell at the bid. Falling back to `last`
    // when there is no book, with slippage still applied.
    const base = side === "buy" ? (quote.ask ?? quote.last) : (quote.bid ?? quote.last);
    if (base === null || !Number.isFinite(base)) return null;
    const adverse = base * this.costs.slippageRate;
    return side === "buy" ? base + adverse : base - adverse;
  }

  private tryTriggerRestingOrder(order: PaperOrder, quote: Quote): void {
    const last = quote.last ?? midPrice(quote);
    if (last === null) return;

    if (order.type === "limit" && order.limitPrice !== null) {
      // A buy limit fills only if the market trades at or below the limit.
      const triggered = order.side === "buy" ? last <= order.limitPrice : last >= order.limitPrice;
      if (triggered) {
        // A resting limit does not pay slippage: it was already at the book.
        this.fill(order, order.limitPrice, quote.provenance.timestamp);
      }
      return;
    }

    if (order.type === "stop" && order.stopPrice !== null) {
      const triggered = order.side === "buy" ? last >= order.stopPrice : last <= order.stopPrice;
      if (triggered) {
        // A triggered stop becomes a market order and pays the spread.
        const price = this.marketFillPrice(quote, order.side);
        if (price !== null) this.fill(order, price, quote.provenance.timestamp);
      }
    }
  }

  private fill(order: PaperOrder, price: number, timestamp: number): void {
    const notional = price * order.quantity * this.contractSize;
    const fees = notional * this.costs.commissionRate + this.costs.commissionFlat;

    order.status = "filled";
    order.filledQuantity = order.quantity;
    order.averageFillPrice = price;
    order.fees = fees;
    order.updatedAt = timestamp;

    this.cash -= fees;
    this.totalFees += fees;
    this.applyFillToPosition(order.symbol, order.side, order.quantity, price, timestamp);
    this.marks.set(order.symbol, price);
    this.updateDrawdown();
  }

  /**
   * Apply a fill to the position book, handling the three cases: opening,
   * adding to a position, and reducing/closing/reversing one.
   */
  private applyFillToPosition(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price: number,
    timestamp: number
  ): void {
    const signed = side === "buy" ? quantity : -quantity;
    const existing = this.positions.get(symbol);

    if (!existing) {
      this.positions.set(symbol, {
        mode: "PAPER",
        symbol,
        side: signed > 0 ? "long" : "short",
        quantity: Math.abs(signed),
        averageEntryPrice: price,
        openedAt: timestamp,
        realizedPnl: 0,
      });
      return;
    }

    const existingSigned = existing.side === "long" ? existing.quantity : -existing.quantity;
    const resultingSigned = existingSigned + signed;

    const sameDirection = Math.sign(existingSigned) === Math.sign(signed);
    if (sameDirection) {
      const totalQuantity = Math.abs(resultingSigned);
      existing.averageEntryPrice =
        (existing.averageEntryPrice * existing.quantity + price * quantity) / totalQuantity;
      existing.quantity = totalQuantity;
      return;
    }

    // Reducing or closing: realise P&L on the closed portion only.
    const closedQuantity = Math.min(existing.quantity, quantity);
    const direction = existing.side === "long" ? 1 : -1;
    const realized =
      (price - existing.averageEntryPrice) * direction * closedQuantity * this.contractSize;
    this.realizedPnl += realized;
    this.cash += realized;
    existing.realizedPnl += realized;

    if (Math.abs(resultingSigned) < 1e-12) {
      this.positions.delete(symbol);
      return;
    }

    if (Math.sign(resultingSigned) !== Math.sign(existingSigned)) {
      // Reversed through flat: the remainder opens a fresh position at `price`.
      this.positions.set(symbol, {
        mode: "PAPER",
        symbol,
        side: resultingSigned > 0 ? "long" : "short",
        quantity: Math.abs(resultingSigned),
        averageEntryPrice: price,
        openedAt: timestamp,
        realizedPnl: existing.realizedPnl,
      });
      return;
    }

    existing.quantity = Math.abs(resultingSigned);
  }

  private positionUnrealized(position: PaperPosition): number {
    const mark = this.marks.get(position.symbol);
    if (mark === undefined) return 0;
    const direction = position.side === "long" ? 1 : -1;
    return (mark - position.averageEntryPrice) * direction * position.quantity * this.contractSize;
  }

  private updateDrawdown(): void {
    const positions = [...this.positions.values()];
    const equity = this.cash + positions.reduce((sum, p) => sum + this.positionUnrealized(p), 0);
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
  }
}

function midPrice(quote: Quote): number | null {
  if (quote.bid !== null && quote.ask !== null) return (quote.bid + quote.ask) / 2;
  return quote.last;
}
