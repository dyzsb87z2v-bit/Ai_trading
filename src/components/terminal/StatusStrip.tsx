"use client";

/**
 * Top status strip (master spec §33): equity, daily P&L, market session,
 * data status and risk status.
 *
 * The data-status pill is the most important element on the page: §32 requires
 * LIVE / DELAYED / HISTORICAL / SIMULATED never be mixed without a label, and
 * this is that label.
 */

import { Badge, type BadgeVariant } from "@/components/ui";
import type { AnalysisView, RiskSettingsView } from "./types";

interface StatusStripProps {
  analysis: AnalysisView | null;
  settings: RiskSettingsView | null;
  dailyPnl: number;
  loading: boolean;
}

/** Colour per data status. STALE and UNAVAILABLE must never look benign. */
function dataStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "LIVE":
      return "success";
    case "DELAYED":
      return "info";
    case "HISTORICAL":
    case "PAPER":
      return "neutral";
    case "SIMULATED":
      return "warning";
    case "STALE":
    case "UNAVAILABLE":
      return "danger";
    default:
      return "neutral";
  }
}

function verdictVariant(verdict: string): BadgeVariant {
  switch (verdict) {
    case "TRADEABLE":
      return "success";
    case "NO_TRADE":
      return "warning";
    case "BLOCKED":
    case "DATA_UNAVAILABLE":
      return "danger";
    default:
      return "neutral";
  }
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-green-600 dark:text-green-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className={`font-mono text-sm font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

export function StatusStrip({ analysis, settings, dailyPnl, loading }: StatusStripProps) {
  const equity = settings?.accountEquity ?? 0;
  const dailyLimit = equity * (settings?.maxDailyLossFraction ?? 0);
  const lossUsed = dailyLimit > 0 ? Math.max(0, -dailyPnl) / dailyLimit : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-black/10 bg-white/60 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
      <Metric label="Equity" value={equity > 0 ? formatMoney(equity) : "Not set"} />
      <Metric
        label="Daily P&L"
        value={formatMoney(dailyPnl)}
        tone={dailyPnl > 0 ? "positive" : dailyPnl < 0 ? "negative" : undefined}
      />
      <Metric
        label="Daily loss budget"
        value={dailyLimit > 0 ? `${(lossUsed * 100).toFixed(0)}% used` : "Not set"}
        tone={lossUsed >= 1 ? "negative" : undefined}
      />

      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">Session</span>
        <span className="font-mono text-sm font-semibold capitalize">
          {analysis ? "regular" : "—"}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">Data status</span>
        {loading ? (
          <Badge variant="neutral" size="sm">
            Loading
          </Badge>
        ) : (
          <Badge variant={dataStatusVariant(analysis?.dataStatus ?? "UNAVAILABLE")} size="sm" dot>
            {analysis?.dataStatus ?? "UNAVAILABLE"}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">Risk status</span>
        <Badge variant={verdictVariant(analysis?.verdict ?? "DATA_UNAVAILABLE")} size="sm" dot>
          {(analysis?.verdict ?? "DATA_UNAVAILABLE").replace(/_/g, " ")}
        </Badge>
      </div>

      {analysis?.dataSource ? (
        <div className="ml-auto flex flex-col text-right">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">Source</span>
          <span className="font-mono text-[11px]">{analysis.dataSource}</span>
        </div>
      ) : null}
    </div>
  );
}

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
