/**
 * Alpaca broker adapter — READ-ONLY by default (master spec §21, §22).
 *
 * The design point that matters more than the mapping: `placeOrder` and
 * `cancelOrder` REFUSE unless the operator has explicitly enabled trading. The
 * refusal lives in the adapter itself, not only in the caller, so a code path
 * that forgets the risk engine still cannot submit an order.
 *
 * Endpoints (https://docs.alpaca.markets/reference):
 *   GET  /v2/account    balances
 *   GET  /v2/positions  open positions
 *   GET  /v2/orders     orders
 *   POST /v2/orders     submit  (gated)
 *   DELETE /v2/orders/{id}      (gated)
 *
 * Paper and live are DIFFERENT hosts. The adapter records which one it is
 * pointed at so nothing downstream can mistake one for the other.
 */

import { available, unavailable, type Availability } from "../../types";
import type {
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  BrokerProvider,
  OrderRequest,
  OrderStatus,
  ProviderDescriptor,
  ProviderHealth,
} from "../types";
import { epochMs, num, type FetchLike } from "./http";

export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
export const ALPACA_LIVE_URL = "https://api.alpaca.markets";

const DESCRIPTOR: ProviderDescriptor = {
  id: "alpaca",
  label: "Alpaca (brokerage)",
  docsUrl: "https://docs.alpaca.markets/reference",
  fields: [
    { key: "apiKeyId", label: "API key id", secret: true, required: true },
    { key: "apiSecret", label: "API secret", secret: true, required: true },
  ],
};

export interface AlpacaOptions {
  apiKeyId?: string;
  apiSecret?: string;
  /** Defaults to the PAPER host. Live must be chosen deliberately. */
  baseUrl?: string;
  /** Must be explicitly true before any order may be submitted. */
  tradingEnabled?: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class AlpacaBrokerProvider implements BrokerProvider {
  readonly kind = "broker" as const;
  readonly descriptor = DESCRIPTOR;
  readonly tradingEnabled: boolean;
  /** True when pointed at the live host rather than paper. */
  readonly isLiveHost: boolean;

  private readonly apiKeyId: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AlpacaOptions = {}) {
    this.apiKeyId = options.apiKeyId?.trim() ?? "";
    this.apiSecret = options.apiSecret?.trim() ?? "";
    // Paper is the default host: reaching the live account must be a choice.
    this.baseUrl = (options.baseUrl ?? ALPACA_PAPER_URL).replace(/\/+$/, "");
    this.isLiveHost = this.baseUrl.startsWith(ALPACA_LIVE_URL);
    this.tradingEnabled = options.tradingEnabled === true;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  isConfigured(): boolean {
    return this.apiKeyId.length > 0 && this.apiSecret.length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = Date.now();
    if (!this.isConfigured()) {
      return {
        configured: false,
        reachable: false,
        message: "No credentials configured.",
        checkedAt,
      };
    }
    const result = await this.request<unknown>("GET", "/v2/account");
    return result.available
      ? {
          configured: true,
          reachable: true,
          message: `Alpaca reachable (${this.isLiveHost ? "LIVE" : "PAPER"} host).`,
          checkedAt,
        }
      : { configured: true, reachable: false, message: result.reason, checkedAt };
  }

  async getAccount(): Promise<Availability<BrokerAccount>> {
    const result = await this.request<unknown>("GET", "/v2/account");
    if (!result.available) return result;

    const record = result.data as Record<string, unknown>;
    const equity = num(record.equity);
    const cash = num(record.cash);
    if (equity === null || cash === null) {
      return unavailable("MALFORMED_RESPONSE", "Alpaca account carried no equity or cash.");
    }

    return available<BrokerAccount>({
      id: typeof record.account_number === "string" ? record.account_number : "unknown",
      currency: typeof record.currency === "string" ? record.currency : "USD",
      equity,
      cash,
      buyingPower: num(record.buying_power),
      asOf: Date.now(),
    });
  }

  async getPositions(): Promise<Availability<BrokerPosition[]>> {
    const result = await this.request<unknown>("GET", "/v2/positions");
    if (!result.available) return result;
    if (!Array.isArray(result.data)) {
      return unavailable("MALFORMED_RESPONSE", "Alpaca returned a non-array positions payload.");
    }

    const positions: BrokerPosition[] = [];
    for (const row of result.data) {
      const position = parseAlpacaPosition(row);
      if (position) positions.push(position);
    }
    return available(positions);
  }

  async getOrders(): Promise<Availability<BrokerOrder[]>> {
    const result = await this.request<unknown>("GET", "/v2/orders?status=all&limit=100");
    if (!result.available) return result;
    if (!Array.isArray(result.data)) {
      return unavailable("MALFORMED_RESPONSE", "Alpaca returned a non-array orders payload.");
    }

    const orders: BrokerOrder[] = [];
    for (const row of result.data) {
      const order = parseAlpacaOrder(row);
      if (order) orders.push(order);
    }
    return available(orders);
  }

  async getOrderStatus(orderId: string): Promise<Availability<BrokerOrder>> {
    const result = await this.request<unknown>("GET", `/v2/orders/${encodeURIComponent(orderId)}`);
    if (!result.available) return result;
    const order = parseAlpacaOrder(result.data);
    if (!order) return unavailable("MALFORMED_RESPONSE", "Alpaca returned an unparseable order.");
    return available(order);
  }

  /**
   * Submit an order. Refuses unless trading was explicitly enabled.
   *
   * This gate is intentionally duplicated with the risk engine: defence in
   * depth means a caller that skips `assessLiveOrder` still cannot trade.
   */
  async placeOrder(request: OrderRequest): Promise<Availability<BrokerOrder>> {
    if (!this.tradingEnabled) {
      return unavailable(
        "TRADING_DISABLED",
        "ORDER EXECUTION DISABLED — this broker connection is read-only. " +
          "Enable trading explicitly before any order can be submitted."
      );
    }
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Alpaca has no credentials configured.");
    }
    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      return unavailable("INVALID_ORDER", "Order quantity must be a positive number.");
    }
    if (request.type === "limit" && !Number.isFinite(request.limitPrice ?? NaN)) {
      return unavailable("INVALID_ORDER", "A limit order requires a limit price.");
    }
    if (request.type === "stop" && !Number.isFinite(request.stopPrice ?? NaN)) {
      return unavailable("INVALID_ORDER", "A stop order requires a stop price.");
    }

    const body: Record<string, unknown> = {
      symbol: request.instrument.symbol,
      qty: String(request.quantity),
      side: request.side,
      type: request.type,
      time_in_force: "day",
      // The caller's id is forwarded so a retry cannot double-submit (§22).
      client_order_id: request.clientOrderId,
    };
    if (request.limitPrice !== undefined) body.limit_price = String(request.limitPrice);
    if (request.stopPrice !== undefined) body.stop_price = String(request.stopPrice);

    const result = await this.request<unknown>("POST", "/v2/orders", body);
    if (!result.available) return result;
    const order = parseAlpacaOrder(result.data);
    if (!order) return unavailable("MALFORMED_RESPONSE", "Alpaca returned an unparseable order.");
    return available(order);
  }

  async cancelOrder(orderId: string): Promise<Availability<BrokerOrder>> {
    if (!this.tradingEnabled) {
      return unavailable(
        "TRADING_DISABLED",
        "ORDER EXECUTION DISABLED — this broker connection is read-only."
      );
    }
    const result = await this.request<unknown>(
      "DELETE",
      `/v2/orders/${encodeURIComponent(orderId)}`
    );
    if (!result.available) return result;
    return this.getOrderStatus(orderId);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Availability<T>> {
    if (!this.isConfigured()) {
      return unavailable("NOT_CONFIGURED", "Alpaca has no credentials configured.");
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "APCA-API-KEY-ID": this.apiKeyId,
          "APCA-API-SECRET-KEY": this.apiSecret,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { method, body: JSON.stringify(body) } : { method }),
      } as never);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return unavailable("NETWORK_ERROR", `Could not reach Alpaca: ${reason}`);
    }

    if (response.status === 401 || response.status === 403) {
      // Never echo the URL or headers: both carry the credential.
      return unavailable("UNAUTHORIZED", "Alpaca rejected the credentials.");
    }
    if (response.status === 429) {
      return unavailable("RATE_LIMITED", "Alpaca rate limit hit — back off before retrying.");
    }
    if (!response.ok) {
      return unavailable("HTTP_ERROR", `Alpaca responded with HTTP ${response.status}.`);
    }

    const payload = await response.json().catch(() => null);
    if (payload === null) {
      return unavailable("MALFORMED_RESPONSE", "Alpaca returned a body that is not valid JSON.");
    }
    return available(payload as T);
  }
}

export function parseAlpacaPosition(row: unknown): BrokerPosition | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const symbol = typeof record.symbol === "string" ? record.symbol : null;
  const quantity = num(record.qty);
  const averageEntryPrice = num(record.avg_entry_price);
  if (symbol === null || quantity === null || averageEntryPrice === null) return null;

  return {
    symbol,
    quantity,
    averageEntryPrice,
    marketValue: num(record.market_value),
    unrealizedPnl: num(record.unrealized_pl),
    asOf: Date.now(),
  };
}

export function parseAlpacaOrder(row: unknown): BrokerOrder | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;

  const id = typeof record.id === "string" ? record.id : null;
  const symbol = typeof record.symbol === "string" ? record.symbol : null;
  const quantity = num(record.qty);
  if (id === null || symbol === null || quantity === null) return null;

  return {
    id,
    clientOrderId: typeof record.client_order_id === "string" ? record.client_order_id : null,
    symbol,
    side: record.side === "sell" ? "sell" : "buy",
    type: mapOrderType(record.type),
    quantity,
    filledQuantity: num(record.filled_qty) ?? 0,
    averageFillPrice: num(record.filled_avg_price),
    status: mapOrderStatus(record.status),
    submittedAt: epochMs(record.submitted_at) ?? Date.now(),
    updatedAt: epochMs(record.updated_at) ?? Date.now(),
  };
}

function mapOrderType(value: unknown): BrokerOrder["type"] {
  if (value === "limit") return "limit";
  if (value === "stop" || value === "stop_limit") return "stop";
  return "market";
}

function mapOrderStatus(value: unknown): OrderStatus {
  switch (value) {
    case "filled":
      return "filled";
    case "partially_filled":
      return "partially_filled";
    case "canceled":
    case "expired":
      return "cancelled";
    case "rejected":
      return "rejected";
    case "new":
    case "accepted":
    case "pending_new":
      return "open";
    default:
      // An unrecognised status is "pending", never "filled": assuming a fill
      // that did not happen is the most dangerous possible default.
      return "pending";
  }
}
