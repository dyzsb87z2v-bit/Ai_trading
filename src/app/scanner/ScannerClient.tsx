"use client";

/**
 * Market scanner (§27).
 *
 * Fetches a series per watched symbol, scans them, and ranks the results. The
 * ranking is the engine's: a blocked setup sorts below every tradeable one, and
 * the table shows WHY rather than only a score.
 */

import { useCallback, useState } from "react";
import { Alert, Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { PageShell } from "@/components/AppNav";

const TIMEFRAMES = ["15m", "30m", "1H", "4H", "1D"] as const;

interface ScanHit {
  symbol: string;
  side: string;
  score: number;
  grade: string;
  state: string;
  verdict: string;
  tradeable: boolean;
  dataStatus: string;
  kinds: string[];
  reasons: string[];
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  regime: string | null;
}

interface ScanResponse {
  hits: ScanHit[];
  failures: { symbol: string; reason: string }[];
  scanned: number;
}

const DEFAULT_SYMBOLS = "AAPL,MSFT,NVDA,AMZN,META,BTCUSD,ETHUSD,EURUSD";

export function ScannerClient() {
  const [symbolText, setSymbolText] = useState(DEFAULT_SYMBOLS);
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>("1H");
  const [tradeableOnly, setTradeableOnly] = useState(false);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    const symbols = symbolText
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 50);
    if (symbols.length === 0) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Series are fetched per symbol, then scanned in one call. Failures are
      // carried into the scan body so the engine can report them rather than
      // the UI silently dropping the symbol.
      const payload: Record<string, unknown>[] = [];
      const fetchFailures: { symbol: string; reason: string }[] = [];

      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        setProgress(`Loading ${symbol} (${i + 1}/${symbols.length})`);
        const assetClass = /USD$/.test(symbol) && symbol.length > 5 ? "crypto" : "stock";
        const res = await fetch(
          `/api/market/series?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&count=300&assetClass=${assetClass}`
        );
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          fetchFailures.push({ symbol, reason: String(data.error ?? "could not load series") });
          continue;
        }
        payload.push({
          symbol,
          assetClass,
          candles: data.candles,
          provenance: data.provenance,
          quote: data.quote
            ? {
                last: (data.quote as Record<string, unknown>).last,
                bid: (data.quote as Record<string, unknown>).bid,
                ask: (data.quote as Record<string, unknown>).ask,
                volume: (data.quote as Record<string, unknown>).volume,
                vwap: (data.quote as Record<string, unknown>).vwap,
                changePercent: (data.quote as Record<string, unknown>).changePercent,
                session: (data.quote as Record<string, unknown>).session,
                provenance: (data.quote as Record<string, unknown>).provenance,
              }
            : null,
        });
      }

      setProgress("Scanning…");
      const scanRes = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeframe, symbols: payload, tradeableOnly, limit: 50 }),
      });
      const scanData = (await scanRes.json().catch(() => ({}))) as ScanResponse & {
        error?: string;
      };
      if (!scanRes.ok) throw new Error(scanData.error ?? "Scan failed");

      setResult({
        ...scanData,
        // Symbols that never reached the scanner are still reported.
        failures: [...fetchFailures, ...(scanData.failures ?? [])],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [symbolText, timeframe, tradeableOnly]);

  return (
    <PageShell
      title="Scanner"
      subtitle="Ranks setups by trade quality. A blocked setup sorts below every tradeable one."
    >
      <Card padding="sm">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
              Symbols
            </label>
            <Input
              value={symbolText}
              onChange={(event) => setSymbolText(event.target.value)}
              className="w-full"
              placeholder="AAPL, MSFT, BTCUSDT"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
              Timeframe
            </label>
            <Select
              value={timeframe}
              onChange={(event) => setTimeframe(event.target.value as typeof timeframe)}
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-1.5 pb-1 text-xs">
            <input
              type="checkbox"
              checked={tradeableOnly}
              onChange={(event) => setTradeableOnly(event.target.checked)}
            />
            Tradeable only
          </label>
          <Button onClick={() => void runScan()} disabled={loading}>
            {loading ? "Scanning…" : "Run scan"}
          </Button>
        </div>
        {progress ? <p className="mt-2 text-[11px] text-muted">{progress}</p> : null}
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {loading && !result ? (
        <div className="flex items-center justify-center py-12">
          <Spinner label="Scanning markets" />
        </div>
      ) : null}

      {result ? (
        <>
          <Card
            title={`Results — ${result.hits.length} of ${result.scanned} scanned`}
            padding="none"
          >
            {result.hits.length === 0 ? (
              <p className="p-4 text-xs text-muted">
                No setup met the criteria. That is a valid result — the scanner does not manufacture
                opportunities.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">State</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2">Verdict</th>
                      <th className="px-3 py-2 text-right">R:R</th>
                      <th className="px-3 py-2 text-right">Entry</th>
                      <th className="px-3 py-2 text-right">Stop</th>
                      <th className="px-3 py-2">Patterns</th>
                      <th className="px-3 py-2">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hits.map((hit) => (
                      <tr key={hit.symbol} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2 font-mono font-semibold">{hit.symbol}</td>
                        <td className="px-3 py-2">
                          <Badge
                            variant={
                              hit.state.includes("BUY")
                                ? "success"
                                : hit.state.includes("SELL")
                                  ? "danger"
                                  : "warning"
                            }
                            size="sm"
                          >
                            {hit.state.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{hit.score.toFixed(0)}</td>
                        <td className="px-3 py-2">
                          <Badge variant={hit.tradeable ? "success" : "danger"} size="sm" dot>
                            {hit.verdict.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {hit.riskReward === null ? "—" : `1:${hit.riskReward.toFixed(2)}`}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {hit.entry === null ? "—" : hit.entry.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-600 dark:text-red-400">
                          {hit.stop === null ? "—" : hit.stop.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-[10px] text-muted">
                          {hit.kinds.length > 0 ? hit.kinds.join(", ") : "—"}
                        </td>
                        <td className="max-w-[280px] px-3 py-2 text-[10px] leading-snug text-muted">
                          {hit.reasons[0] ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {result.failures.length > 0 ? (
            <Alert
              tone="warning"
              title={`${result.failures.length} symbol(s) could not be analysed`}
            >
              <ul className="list-disc pl-4">
                {result.failures.map((failure) => (
                  <li key={failure.symbol}>
                    <span className="font-mono">{failure.symbol}</span>: {failure.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </>
      ) : null}
    </PageShell>
  );
}
