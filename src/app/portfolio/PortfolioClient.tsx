"use client";

/**
 * Portfolio dashboard and paper trading (§20, §24).
 *
 * Everything on this page is PAPER. The badge is not decoration: §20 requires
 * paper and live never be confused, and this is the whole of that guarantee on
 * this screen.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { PageShell } from "@/components/AppNav";

interface JournalRow {
  id: string;
  symbol: string;
  side: string;
  openedAt: number;
  closedAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  netPnl: number | null;
  rMultiple: number | null;
  executionMode: string;
}

interface PaperState {
  mode: string;
  initialCapital: number;
  realizedPnl: number;
  equity: number;
  openPositions: JournalRow[];
  trades: JournalRow[];
  statistics: {
    totalTrades: number;
    winRate: number;
    profitFactor: number | null;
    expectancy: number;
    averageR: number | null;
    netPnl: number;
    maxDrawdown: number;
  };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const toneClass =
    tone === "up"
      ? "text-green-600 dark:text-green-400"
      : tone === "down"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-mono text-sm font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

export function PortfolioClient() {
  const [state, setState] = useState<PaperState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState("AAPL");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("10");
  const [price, setPrice] = useState("");
  /** Exit price per open position, keyed by entry id. */
  const [closePrices, setClosePrices] = useState<Record<string, string>>({});
  const [closingId, setClosingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/paper");
      const data = (await res.json().catch(() => ({}))) as PaperState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not load the paper account");
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the paper account");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setError(null);
    const qty = Number(quantity);
    const fillPrice = Number(price);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Quantity must be a positive number.");
      return;
    }
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      setError("A market paper order needs a price to fill against.");
      return;
    }
    const res = await fetch("/api/paper", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: symbol.trim().toUpperCase(),
        side,
        type: "market",
        quantity: qty,
        price: fillPrice,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(data.error ?? "The order was rejected.");
      return;
    }
    await load();
  }, [symbol, side, quantity, price, load]);

  const closePosition = useCallback(
    async (id: string) => {
      setError(null);
      const exitPrice = Number(closePrices[id]);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        // Same rule as the entry: a close filled at a guessed price would put a
        // fabricated P&L into the journal, where it would look like a result.
        setError("Closing a position needs the price it filled at.");
        return;
      }
      setClosingId(id);
      try {
        const res = await fetch("/api/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "close", entryId: id, price: exitPrice }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(data.error ?? "The position could not be closed.");
          return;
        }
        setClosePrices((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await load();
      } finally {
        setClosingId(null);
      }
    },
    [closePrices, load]
  );

  const stats = state?.statistics;

  return (
    <PageShell
      title="Portfolio"
      subtitle="Simulated execution on real prices. Nothing here reaches a broker."
      actions={
        <Badge variant="warning" size="lg" dot>
          Paper
        </Badge>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : state ? (
        <>
          <Card padding="sm">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Equity" value={state.equity.toFixed(2)} />
              <Stat label="Initial capital" value={state.initialCapital.toFixed(2)} />
              <Stat
                label="Realised P&L"
                value={state.realizedPnl.toFixed(2)}
                tone={state.realizedPnl > 0 ? "up" : state.realizedPnl < 0 ? "down" : undefined}
              />
              <Stat label="Open positions" value={String(state.openPositions.length)} />
              <Stat label="Closed trades" value={String(stats?.totalTrades ?? 0)} />
              <Stat label="Win rate" value={stats ? `${(stats.winRate * 100).toFixed(0)}%` : "—"} />
              <Stat
                label="Profit factor"
                value={
                  stats?.profitFactor === null || stats === undefined
                    ? "—"
                    : stats.profitFactor.toFixed(2)
                }
              />
              <Stat
                label="Average R"
                value={
                  stats?.averageR === null || stats === undefined ? "—" : stats.averageR.toFixed(2)
                }
              />
              <Stat
                label="Max drawdown"
                value={stats ? stats.maxDrawdown.toFixed(2) : "—"}
                tone={stats && stats.maxDrawdown > 0 ? "down" : undefined}
              />
            </div>
          </Card>

          <Card title="Place a paper order" padding="sm">
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                  Symbol
                </label>
                <Input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  className="w-24"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                  Side
                </label>
                <Select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")}>
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                  Quantity
                </label>
                <Input
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  inputMode="decimal"
                  className="w-24"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                  Fill price
                </label>
                <Input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  inputMode="decimal"
                  className="w-28"
                  placeholder="required"
                />
              </div>
              <Button onClick={() => void submit()}>Submit paper order</Button>
            </div>
            <p className="mt-2 text-[10px] text-muted">
              A market paper order needs a price to fill against — filling at a guessed price would
              make the results meaningless.
            </p>
          </Card>

          <Card title={`Open positions (${state.openPositions.length})`} padding="none">
            {state.openPositions.length === 0 ? (
              <p className="p-4 text-xs text-muted">No open positions.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">Side</th>
                      <th className="px-3 py-2 text-right">Quantity</th>
                      <th className="px-3 py-2 text-right">Entry</th>
                      <th className="px-3 py-2">Opened</th>
                      <th className="px-3 py-2">Mode</th>
                      <th className="px-3 py-2 text-right">Close</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.openPositions.map((row) => (
                      <tr key={row.id} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-mono font-semibold">{row.symbol}</td>
                        <td className="px-3 py-2 uppercase">{row.side}</td>
                        <td className="px-3 py-2 text-right font-mono">{row.quantity}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {row.entryPrice.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-muted">
                          {new Date(row.openedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="warning" size="sm">
                            {row.executionMode}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-2">
                            <Input
                              value={closePrices[row.id] ?? ""}
                              onChange={(e) =>
                                setClosePrices((prev) => ({ ...prev, [row.id]: e.target.value }))
                              }
                              inputMode="decimal"
                              className="w-24"
                              placeholder="exit price"
                              aria-label={`Exit price for ${row.symbol}`}
                            />
                            <Button
                              variant="secondary"
                              onClick={() => void closePosition(row.id)}
                              disabled={closingId === row.id}
                            >
                              {closingId === row.id ? "Closing…" : "Close"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
