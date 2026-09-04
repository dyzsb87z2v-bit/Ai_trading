"use client";

/**
 * Trading journal (§23).
 *
 * Statistics come from the engine, not the component: average R is computed
 * over only the trades that recorded their risk, and a profit factor with no
 * losing trades reads "—" rather than infinity.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Card, Spinner } from "@/components/ui";
import { PageShell } from "@/components/AppNav";

interface Entry {
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
  strategy: string | null;
  marketRegime: string | null;
  signalScore: number | null;
  executionMode: string;
}

interface PeriodPnl {
  period: string;
  netPnl: number;
  trades: number;
}

interface Statistics {
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number | null;
  averageWin: number;
  averageLoss: number;
  netPnl: number;
  maxDrawdown: number;
  byPeriod: { daily: PeriodPnl[]; weekly: PeriodPnl[]; monthly: PeriodPnl[] };
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

export function JournalClient() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [stats, setStats] = useState<Statistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/journal");
      const data = (await res.json().catch(() => ({}))) as {
        entries?: Entry[];
        statistics?: Statistics;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not load the journal");
      setEntries(data.entries ?? []);
      setStats(data.statistics ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the journal");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageShell
      title="Journal"
      subtitle="Every recorded trade, and what the record says about them."
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          <Card padding="sm">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Trades" value={String(stats?.totalTrades ?? 0)} />
              <Stat label="Win rate" value={stats ? `${(stats.winRate * 100).toFixed(0)}%` : "—"} />
              <Stat
                label="Profit factor"
                value={!stats || stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}
              />
              <Stat label="Expectancy" value={stats ? stats.expectancy.toFixed(2) : "—"} />
              <Stat
                label="Average R"
                value={!stats || stats.averageR === null ? "—" : stats.averageR.toFixed(2)}
              />
              <Stat
                label="Average win"
                value={stats ? stats.averageWin.toFixed(2) : "—"}
                tone="up"
              />
              <Stat
                label="Average loss"
                value={stats ? stats.averageLoss.toFixed(2) : "—"}
                tone="down"
              />
              <Stat
                label="Net P&L"
                value={stats ? stats.netPnl.toFixed(2) : "—"}
                tone={
                  stats && stats.netPnl > 0 ? "up" : stats && stats.netPnl < 0 ? "down" : undefined
                }
              />
              <Stat
                label="Max drawdown"
                value={stats ? stats.maxDrawdown.toFixed(2) : "—"}
                tone="down"
              />
            </div>
            {stats && stats.profitFactor === null && stats.totalTrades > 0 ? (
              <p className="mt-2 text-[10px] text-muted">
                Profit factor reads “—” because there are no losing trades yet: with no losses the
                ratio is unmeasurable, not infinite.
              </p>
            ) : null}
          </Card>

          {stats && stats.byPeriod.monthly.length > 0 ? (
            <Card title="Monthly P&L" padding="sm">
              <div className="flex flex-wrap gap-4">
                {stats.byPeriod.monthly.map((period) => (
                  <div key={period.period} className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-wide text-muted">
                      {period.period}
                    </span>
                    <span
                      className={`font-mono text-sm font-semibold ${
                        period.netPnl > 0
                          ? "text-green-600 dark:text-green-400"
                          : period.netPnl < 0
                            ? "text-red-600 dark:text-red-400"
                            : ""
                      }`}
                    >
                      {period.netPnl.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-muted">{period.trades} trade(s)</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title={`Entries (${entries.length})`} padding="none">
            {entries.length === 0 ? (
              <p className="p-4 text-xs text-muted">
                No entries yet. Trades placed on the Portfolio page are recorded here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">Side</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Entry</th>
                      <th className="px-3 py-2 text-right">Exit</th>
                      <th className="px-3 py-2 text-right">Net P&L</th>
                      <th className="px-3 py-2 text-right">R</th>
                      <th className="px-3 py-2">Regime</th>
                      <th className="px-3 py-2">Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-mono font-semibold">{entry.symbol}</td>
                        <td className="px-3 py-2 uppercase">{entry.side}</td>
                        <td className="px-3 py-2 text-right font-mono">{entry.quantity}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {entry.entryPrice.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {entry.exitPrice === null ? "open" : entry.exitPrice.toFixed(2)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-mono ${
                            (entry.netPnl ?? 0) > 0
                              ? "text-green-600 dark:text-green-400"
                              : (entry.netPnl ?? 0) < 0
                                ? "text-red-600 dark:text-red-400"
                                : ""
                          }`}
                        >
                          {entry.netPnl === null ? "—" : entry.netPnl.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {entry.rMultiple === null ? "—" : `${entry.rMultiple.toFixed(2)}R`}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-muted">
                          {entry.marketRegime ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="warning" size="sm">
                            {entry.executionMode}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </PageShell>
  );
}
