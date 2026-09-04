"use client";

/**
 * Strategy Lab (§19).
 *
 * Builds an IF/AND/THEN rule tree from a form and backtests it. The tree is
 * DATA sent to the server, never code — the server validates it before
 * compiling, so a broken rule is rejected with field-level messages rather than
 * silently producing a strategy that never triggers.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { PageShell } from "@/components/AppNav";

const INDICATORS = [
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "rsi",
  "macdHistogram",
  "adx",
  "stochK",
  "cci",
  "roc",
  "vwap",
  "relativeVolume",
  "percentB",
] as const;

const OPERATORS = [
  { id: "gt", label: ">" },
  { id: "gte", label: "≥" },
  { id: "lt", label: "<" },
  { id: "lte", label: "≤" },
] as const;

interface ConditionRow {
  left: string;
  operator: string;
  rightKind: "constant" | "indicator" | "price";
  rightValue: string;
}

interface Metrics {
  netProfit: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number | null;
  totalTrades: number;
  winningStreak: number;
  losingStreak: number;
  totalFees: number;
}

export function StrategiesClient() {
  const [presets, setPresets] = useState<{ id: string; name: string; side: string }[]>([]);
  const [conditions, setConditions] = useState<ConditionRow[]>([
    { left: "rsi", operator: "gt", rightKind: "constant", rightValue: "50" },
  ]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [stopAtr, setStopAtr] = useState("2");
  const [targetR, setTargetR] = useState("2.5");
  const [symbol, setSymbol] = useState("AAPL");
  const [timeframe, setTimeframe] = useState("1H");

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/strategies");
      const data = (await res.json().catch(() => ({}))) as {
        presets?: { id: string; name: string; side: string }[];
      };
      setPresets(data.presets ?? []);
    })();
  }, []);

  /** Turn the form rows into the rule tree the API expects. */
  const buildDefinition = useCallback(() => {
    const all = conditions.map((row) => ({
      condition: {
        type: "compare" as const,
        left: { kind: "indicator" as const, id: row.left },
        operator: row.operator,
        right:
          row.rightKind === "constant"
            ? { kind: "constant" as const, value: Number(row.rightValue) }
            : row.rightKind === "price"
              ? { kind: "price" as const, field: "close" as const }
              : { kind: "indicator" as const, id: row.rightValue },
      },
    }));
    return {
      name: "Custom strategy",
      side,
      entry: all.length === 1 ? all[0] : { all },
      stop: { type: "atr", multiple: Number(stopAtr) },
      target: { type: "r", multiple: Number(targetR) },
    };
  }, [conditions, side, stopAtr, targetR]);

  const runBacktest = useCallback(
    async (presetId?: string) => {
      setRunning(true);
      setError(null);
      setIssues([]);
      setMetrics(null);
      setWarnings([]);
      try {
        const seriesRes = await fetch(
          `/api/market/series?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&count=1000&assetClass=stock`
        );
        const seriesData = (await seriesRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!seriesRes.ok) throw new Error(String(seriesData.error ?? "Could not load series"));

        const body: Record<string, unknown> = {
          symbol,
          timeframe,
          candles: seriesData.candles,
          initialCapital: 100_000,
          riskPerTrade: 0.01,
          commissionRate: 0.0005,
          slippageRate: 0.0005,
        };
        if (presetId) body.preset = presetId;
        else body.definition = buildDefinition();

        const res = await fetch("/api/backtest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          metrics?: Metrics;
          warnings?: string[];
          issues?: { path: string; message: string }[];
          error?: string;
        };
        if (!res.ok) {
          setIssues(data.issues ?? []);
          throw new Error(data.error ?? "Backtest failed");
        }
        setMetrics(data.metrics ?? null);
        setWarnings(data.warnings ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Backtest failed");
      } finally {
        setRunning(false);
      }
    },
    [symbol, timeframe, buildDefinition]
  );

  return (
    <PageShell
      title="Strategy Lab"
      subtitle="Rules are data, validated server-side before they run. Never executable code."
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {issues.length > 0 ? (
        <Alert tone="warning" title="The rule tree was rejected">
          <ul className="list-disc pl-4">
            {issues.map((issue, i) => (
              <li key={i}>
                <span className="font-mono">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card title="Presets" padding="sm">
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <Button
              key={preset.id}
              size="sm"
              variant="secondary"
              disabled={running}
              onClick={() => void runBacktest(preset.id)}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      </Card>

      <Card title="Build a rule — IF … AND … THEN" padding="sm">
        <div className="flex flex-col gap-2">
          {conditions.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <span className="w-8 text-[10px] uppercase text-muted">
                {index === 0 ? "IF" : "AND"}
              </span>
              <Select
                value={row.left}
                onChange={(e) =>
                  setConditions((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, left: e.target.value } : r))
                  )
                }
              >
                {INDICATORS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
              <Select
                value={row.operator}
                onChange={(e) =>
                  setConditions((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, operator: e.target.value } : r))
                  )
                }
              >
                {OPERATORS.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.label}
                  </option>
                ))}
              </Select>
              <Select
                value={row.rightKind}
                onChange={(e) =>
                  setConditions((prev) =>
                    prev.map((r, i) =>
                      i === index
                        ? { ...r, rightKind: e.target.value as ConditionRow["rightKind"] }
                        : r
                    )
                  )
                }
              >
                <option value="constant">a number</option>
                <option value="indicator">an indicator</option>
                <option value="price">close price</option>
              </Select>
              {row.rightKind === "constant" ? (
                <Input
                  value={row.rightValue}
                  onChange={(e) =>
                    setConditions((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, rightValue: e.target.value } : r))
                    )
                  }
                  inputMode="decimal"
                  className="w-24"
                />
              ) : row.rightKind === "indicator" ? (
                <Select
                  value={row.rightValue}
                  onChange={(e) =>
                    setConditions((prev) =>
                      prev.map((r, i) => (i === index ? { ...r, rightValue: e.target.value } : r))
                    )
                  }
                >
                  {INDICATORS.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </Select>
              ) : null}
              {conditions.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}

          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setConditions((prev) => [
                  ...prev,
                  { left: "adx", operator: "gt", rightKind: "constant", rightValue: "25" },
                ])
              }
            >
              Add condition
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <span className="w-8 text-[10px] uppercase text-muted">THEN</span>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Side
              </label>
              <Select value={side} onChange={(e) => setSide(e.target.value as "long" | "short")}>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Stop (ATR)
              </label>
              <Input
                value={stopAtr}
                onChange={(e) => setStopAtr(e.target.value)}
                className="w-20"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Target (R)
              </label>
              <Input
                value={targetR}
                onChange={(e) => setTargetR(e.target.value)}
                className="w-20"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Symbol
              </label>
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-24" />
            </div>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
                Timeframe
              </label>
              <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {["15m", "30m", "1H", "4H", "1D"].map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </Select>
            </div>
            <Button onClick={() => void runBacktest()} disabled={running}>
              {running ? "Running…" : "Backtest"}
            </Button>
          </div>
        </div>
      </Card>

      {running ? (
        <div className="flex justify-center py-8">
          <Spinner label="Running backtest" />
        </div>
      ) : null}

      {metrics ? (
        <Card title="Backtest result" padding="sm">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Trades" value={String(metrics.totalTrades)} />
            <Stat
              label="Net profit"
              value={metrics.netProfit.toFixed(2)}
              tone={metrics.netProfit > 0 ? "up" : metrics.netProfit < 0 ? "down" : undefined}
            />
            <Stat label="Win rate" value={`${(metrics.winRate * 100).toFixed(0)}%`} />
            <Stat
              label="Profit factor"
              value={metrics.profitFactor === null ? "—" : metrics.profitFactor.toFixed(2)}
            />
            <Stat label="Expectancy" value={metrics.expectancy.toFixed(2)} />
            <Stat
              label="Max drawdown"
              value={`${metrics.maxDrawdown.toFixed(2)} (${(metrics.maxDrawdownPercent * 100).toFixed(1)}%)`}
              tone="down"
            />
            <Stat
              label="Sharpe"
              value={metrics.sharpeRatio === null ? "—" : metrics.sharpeRatio.toFixed(2)}
            />
            <Stat label="Win streak" value={String(metrics.winningStreak)} />
            <Stat label="Loss streak" value={String(metrics.losingStreak)} />
            <Stat label="Fees" value={metrics.totalFees.toFixed(2)} />
          </div>

          {metrics.totalTrades === 0 ? (
            <p className="mt-3 text-[11px] text-muted">
              The rule never triggered on this data. That is a result, not a failure — a strategy
              with no entries is telling you something.
            </p>
          ) : null}

          {warnings.length > 0 ? (
            <ul className="mt-3 list-disc pl-4 text-[10px] text-muted">
              {warnings.slice(0, 5).map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <Badge variant="warning" size="sm">
              Simulated
            </Badge>
            <span className="text-[10px] text-muted">
              Past results on historical data. Fills assume the stop wins on any bar that touches
              both stop and target.
            </span>
          </div>
        </Card>
      ) : null}
    </PageShell>
  );
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
