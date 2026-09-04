"use client";

/**
 * Trading terminal.
 *
 * Layout: status strip on top, watchlist left, chart centre, Copilot right,
 * docked analysis panels below. The three columns share a fixed height and
 * scroll internally, so the chart never stretches to match the Copilot column.
 *
 * The page never renders a market value it did not receive from the API. With
 * no provider configured it says so and labels the synthetic series it shows
 * instead.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { computeIndicatorSet } from "@/lib/trading/indicators";
import { CandleChart, type ChartLevel, type ChartOverlay } from "@/components/terminal/CandleChart";
import { StatusStrip } from "@/components/terminal/StatusStrip";
import { CopilotPanel } from "@/components/terminal/CopilotPanel";
import { BottomPanels } from "@/components/terminal/BottomPanels";
import { WatchlistPanel, type WatchlistRow } from "@/components/terminal/WatchlistPanel";
import type {
  AnalysisView,
  ProviderStatusView,
  RiskSettingsView,
  TerminalCandle,
  TerminalQuote,
} from "@/components/terminal/types";

const TIMEFRAMES = ["5m", "15m", "30m", "1H", "4H", "1D"] as const;
type TerminalTimeframe = (typeof TIMEFRAMES)[number];

const DEFAULT_SYMBOLS: { symbol: string; assetClass: string }[] = [
  { symbol: "AAPL", assetClass: "stock" },
  { symbol: "MSFT", assetClass: "stock" },
  { symbol: "NVDA", assetClass: "stock" },
  { symbol: "BTCUSD", assetClass: "crypto" },
  { symbol: "EURUSD", assetClass: "forex" },
];

interface SeriesState {
  candles: TerminalCandle[];
  quote: TerminalQuote | null;
  provenance: { source: string; timestamp: number; status: string };
  notice: string | null;
  simulated: boolean;
}

export function TerminalClient() {
  const router = useRouter();
  const [providers, setProviders] = useState<ProviderStatusView[]>([]);
  const [copilotConfigured, setCopilotConfigured] = useState(false);
  const [settings, setSettings] = useState<RiskSettingsView | null>(null);
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [activeSymbol, setActiveSymbol] = useState(DEFAULT_SYMBOLS[0].symbol);
  const [timeframe, setTimeframe] = useState<TerminalTimeframe>("1H");
  const [draft, setDraft] = useState("");

  const [series, setSeries] = useState<SeriesState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, { score: number; state: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [equityDraft, setEquityDraft] = useState("");
  const [copilotText, setCopilotText] = useState<string | null>(null);
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotError, setCopilotError] = useState<string | null>(null);

  const marketProvider = providers.find((p) => p.kind === "market-data");
  const hasRealProvider = marketProvider?.available === true;
  const activeAssetClass =
    symbols.find((entry) => entry.symbol === activeSymbol)?.assetClass ?? "stock";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providersRes, settingsRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/risk-settings"),
        ]);
        // A 401 means the session expired while the page was open.
        if (providersRes.status === 401) {
          router.replace("/login");
          return;
        }
        const providersData = (await providersRes.json().catch(() => ({}))) as {
          providers?: ProviderStatusView[];
          copilotConfigured?: boolean;
        };
        const settingsData = (await settingsRes.json().catch(() => ({}))) as {
          settings?: RiskSettingsView;
        };
        if (cancelled) return;
        if (Array.isArray(providersData.providers)) setProviders(providersData.providers);
        setCopilotConfigured(providersData.copilotConfigured === true);
        if (settingsData.settings) {
          setSettings(settingsData.settings);
          setEquityDraft(
            settingsData.settings.accountEquity > 0
              ? String(settingsData.settings.accountEquity)
              : ""
          );
        }
      } catch {
        if (!cancelled) setError("Could not reach the API.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loadSymbol = useCallback(
    async (symbol: string, assetClass: string, tf: TerminalTimeframe) => {
      setLoading(true);
      setError(null);
      setCopilotText(null);
      setCopilotError(null);
      try {
        const seriesRes = await fetch(
          `/api/market/series?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}` +
            `&count=320&assetClass=${assetClass}`
        );
        const seriesData = (await seriesRes.json().catch(() => ({}))) as Record<string, unknown>;
        if (!seriesRes.ok) throw new Error(String(seriesData.error ?? "Failed to load series"));

        const loaded: SeriesState = {
          candles: (seriesData.candles as TerminalCandle[]) ?? [],
          quote: (seriesData.quote as TerminalQuote | null) ?? null,
          provenance: seriesData.provenance as SeriesState["provenance"],
          notice: (seriesData.notice as string | null) ?? null,
          simulated: seriesData.simulated === true,
        };
        setSeries(loaded);

        const analyzeRes = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            instrument: { symbol, assetClass },
            timeframe: tf,
            candles: loaded.candles,
            provenance: loaded.provenance,
            quote: loaded.quote
              ? {
                  last: loaded.quote.last,
                  bid: loaded.quote.bid,
                  ask: loaded.quote.ask,
                  volume: loaded.quote.volume,
                  vwap: loaded.quote.vwap,
                  changePercent: loaded.quote.changePercent,
                  session: loaded.quote.session,
                  provenance: loaded.quote.provenance,
                }
              : null,
            dailyPnl: 0,
            openPositions: [],
          }),
        });
        const analyzeData = (await analyzeRes.json().catch(() => ({}))) as {
          analysis?: AnalysisView;
          copilotMessages?: { role: string; content: string }[];
          error?: string;
        };
        if (!analyzeRes.ok) throw new Error(analyzeData.error ?? "Analysis failed");

        setAnalysis(analyzeData.analysis ?? null);
        // Only the evidence half is kept: the system prompt is server-side.
        setEvidence(analyzeData.copilotMessages?.[1]?.content ?? null);
        if (analyzeData.analysis?.signal) {
          setScores((prev) => ({
            ...prev,
            [symbol]: {
              score: analyzeData.analysis!.signal!.score,
              state: analyzeData.analysis!.signal!.state,
            },
          }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load symbol");
        setAnalysis(null);
        setSeries(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadSymbol(activeSymbol, activeAssetClass, timeframe);
  }, [activeSymbol, activeAssetClass, timeframe, loadSymbol]);

  const overlays: ChartOverlay[] = useMemo(() => {
    if (!series || series.candles.length === 0) return [];
    const indicators = computeIndicatorSet(series.candles);
    return [
      { id: "ema20", label: "EMA 20", color: "#3b82f6", values: indicators.ema20 },
      { id: "ema50", label: "EMA 50", color: "#a855f7", values: indicators.ema50 },
      { id: "ema200", label: "EMA 200", color: "#f59e0b", values: indicators.ema200 },
      { id: "vwap", label: "VWAP", color: "#14b8a6", values: indicators.vwap },
    ];
  }, [series]);

  const chartLevels: ChartLevel[] = useMemo(() => {
    const structure = analysis?.structure;
    if (!structure) return [];
    return [
      ...structure.resistance.slice(0, 2).map((l) => ({
        price: l.price,
        label: "R",
        color: "#dc2626",
        dashed: true,
      })),
      ...structure.support.slice(0, 2).map((l) => ({
        price: l.price,
        label: "S",
        color: "#16a34a",
        dashed: true,
      })),
    ];
  }, [analysis]);

  const watchlistRows: WatchlistRow[] = symbols.map((entry) => {
    const isActive = entry.symbol === activeSymbol;
    const cached = scores[entry.symbol];
    return {
      symbol: entry.symbol,
      assetClass: entry.assetClass,
      last: isActive ? (series?.quote?.last ?? null) : null,
      changePercent: isActive ? (series?.quote?.changePercent ?? null) : null,
      score: cached?.score ?? null,
      state: cached?.state ?? null,
      dataStatus: isActive ? (analysis?.dataStatus ?? null) : null,
    };
  });

  const saveEquity = useCallback(async () => {
    const value = Number(equityDraft);
    if (!Number.isFinite(value) || value < 0) return;
    const res = await fetch("/api/risk-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountEquity: value }),
    });
    const data = (await res.json().catch(() => ({}))) as { settings?: RiskSettingsView };
    if (data.settings) {
      setSettings(data.settings);
      void loadSymbol(activeSymbol, activeAssetClass, timeframe);
    }
  }, [equityDraft, activeSymbol, activeAssetClass, timeframe, loadSymbol]);

  const askCopilot = useCallback(async () => {
    if (!evidence) return;
    setCopilotLoading(true);
    setCopilotError(null);
    setCopilotText(null);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidence }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
        audit?: { clean: boolean; violations: string[] };
      };
      if (!res.ok) throw new Error(data.error ?? "Copilot request failed");
      setCopilotText(data.text ?? "");
      if (data.audit && !data.audit.clean) {
        setCopilotError(
          `Output flagged: ${data.audit.violations.join(", ")}. Treat the text above with caution.`
        );
      }
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : "Copilot request failed");
    } finally {
      setCopilotLoading(false);
    }
  }, [evidence]);

  return (
    <div className="flex min-h-screen flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold">AI Trading Terminal</h1>
          <p className="text-xs text-muted">
            Signals, risk control and trade planning. Analysis only — no orders are placed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] uppercase tracking-wide text-muted">Equity</label>
          <Input
            value={equityDraft}
            onChange={(event) => setEquityDraft(event.target.value)}
            onBlur={() => void saveEquity()}
            placeholder="0"
            inputMode="decimal"
            className="w-28"
            aria-label="Account equity"
          />
          <Select
            value={timeframe}
            onChange={(event) => setTimeframe(event.target.value as TerminalTimeframe)}
            aria-label="Timeframe"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void loadSymbol(activeSymbol, activeAssetClass, timeframe)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              router.replace("/login");
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      {!hasRealProvider ? (
        <Alert
          tone="warning"
          title={
            <span className="flex items-center gap-2">
              <Badge variant="warning" size="sm" dot>
                Simulated
              </Badge>
              {marketProvider?.unavailableMessage ??
                "DATA SOURCE UNAVAILABLE — no market-data provider is configured."}
            </span>
          }
        >
          {series?.notice ??
            "The chart below is a synthetic series for interface demonstration only. It is not market data."}{" "}
          Because the data is <span className="font-mono">SIMULATED</span>, the freshness gate
          disables live analysis and the risk engine cannot return a tradeable verdict — exactly as
          it would on a stale live feed.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <StatusStrip analysis={analysis} settings={settings} dailyPnl={0} loading={loading} />

      <div className="grid gap-3 lg:h-[620px] lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <Card title="Watchlist" padding="sm" className="lg:h-full lg:overflow-hidden">
          <WatchlistPanel
            rows={watchlistRows}
            activeSymbol={activeSymbol}
            onSelect={setActiveSymbol}
            onAdd={(symbol) => {
              if (!symbols.some((entry) => entry.symbol === symbol)) {
                setSymbols((prev) => [...prev, { symbol, assetClass: "stock" }]);
              }
              setActiveSymbol(symbol);
              setDraft("");
            }}
            onRemove={(symbol) => {
              setSymbols((prev) => {
                const next = prev.filter((entry) => entry.symbol !== symbol);
                if (symbol === activeSymbol && next.length > 0) setActiveSymbol(next[0].symbol);
                return next;
              });
            }}
            draft={draft}
            onDraftChange={setDraft}
          />
        </Card>

        <Card
          padding="sm"
          className="lg:h-full lg:overflow-hidden"
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono">{activeSymbol}</span>
              <span className="text-xs font-normal text-muted">{timeframe}</span>
              {series?.quote?.last != null ? (
                <span className="font-mono text-sm">{series.quote.last.toFixed(2)}</span>
              ) : null}
            </span>
          }
        >
          {loading && !series ? (
            <div className="flex h-[420px] items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <CandleChart
              candles={series?.candles ?? []}
              overlays={overlays}
              levels={chartLevels}
              plan={analysis?.levels ?? null}
              height={420}
              watermark={analysis?.dataStatus === "SIMULATED" ? "SIMULATED" : undefined}
            />
          )}
        </Card>

        <div className="flex flex-col gap-3 lg:h-full lg:overflow-y-auto lg:pr-1">
          {!copilotConfigured ? (
            <Alert tone="info" title="Copilot not configured">
              Set <span className="font-mono">COPILOT_BASE_URL</span> and{" "}
              <span className="font-mono">COPILOT_MODEL</span> in{" "}
              <span className="font-mono">.env</span> to enable the narrative. Every score and level
              on this page is computed without it.
            </Alert>
          ) : null}
          <CopilotPanel
            analysis={analysis}
            copilotText={copilotText}
            copilotLoading={copilotLoading}
            copilotError={copilotError}
            onAskCopilot={() => void askCopilot()}
          />
        </div>
      </div>

      <BottomPanels analysis={analysis} />

      <footer className="text-[10px] leading-snug text-muted">
        This terminal provides analysis and risk control only. It does not place orders, does not
        predict prices, and makes no guarantee of any outcome. NO TRADE and WAIT are valid results.
      </footer>
    </div>
  );
}
