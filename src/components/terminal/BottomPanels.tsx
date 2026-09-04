"use client";

/**
 * Bottom docked panels (master spec §12, §22, §33, §37).
 *
 * Tabs: the risk checklist, the trade plan, market structure and multi-timeframe.
 * The risk checklist is first because it is the panel that decides whether
 * anything else on the page may be acted on.
 */

import { useState } from "react";
import { Badge } from "@/components/ui";
import type { AnalysisView } from "./types";

type TabId = "risk" | "plan" | "structure" | "mtf";

const TABS: { id: TabId; label: string }[] = [
  { id: "risk", label: "Risk checks" },
  { id: "plan", label: "Trade plan" },
  { id: "structure", label: "Structure" },
  { id: "mtf", label: "Multi-timeframe" },
];

export function BottomPanels({ analysis }: { analysis: AnalysisView | null }) {
  const [tab, setTab] = useState<TabId>("risk");

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10">
      <div className="flex items-center gap-1 border-b border-black/10 px-2 pt-2 dark:border-white/10">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={`rounded-t-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === entry.id
                ? "bg-black/5 text-text dark:bg-white/10"
                : "text-text-muted hover:text-text"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="max-h-64 overflow-y-auto p-3">
        {!analysis ? (
          <p className="text-xs text-text-muted">Run an analysis to populate these panels.</p>
        ) : tab === "risk" ? (
          <RiskTab analysis={analysis} />
        ) : tab === "plan" ? (
          <PlanTab analysis={analysis} />
        ) : tab === "structure" ? (
          <StructureTab analysis={analysis} />
        ) : (
          <MtfTab analysis={analysis} />
        )}
      </div>
    </div>
  );
}

function RiskTab({ analysis }: { analysis: AnalysisView }) {
  const risk = analysis.risk;
  if (!risk) return <p className="text-xs text-text-muted">The risk engine did not run.</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge
          variant={
            risk.verdict === "ALLOWED"
              ? "success"
              : risk.verdict === "WARNED"
                ? "warning"
                : "danger"
          }
          size="md"
          dot
        >
          {risk.verdict}
        </Badge>
        <span className="text-[11px] text-text-muted">
          {risk.checks.filter((c) => c.passed).length} of {risk.checks.length} checks passed
        </span>
      </div>

      <div className="grid gap-1 sm:grid-cols-2">
        {risk.checks.map((check) => (
          <div
            key={check.id}
            className="flex items-start gap-2 rounded-md border border-black/5 px-2 py-1.5 dark:border-white/5"
          >
            <span
              className={`mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ${
                check.passed ? "bg-green-500" : check.indeterminate ? "bg-yellow-500" : "bg-red-500"
              }`}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wide">
                  {check.id.replace(/_/g, " ")}
                </span>
                {check.critical ? (
                  <span className="text-[9px] uppercase text-text-muted">critical</span>
                ) : null}
              </div>
              <p className="text-[11px] leading-snug text-text-muted">{check.message}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanTab({ analysis }: { analysis: AnalysisView }) {
  const levels = analysis.levels;
  const sizing = analysis.sizing;

  if (!levels) {
    return (
      <p className="text-xs text-text-muted">
        No coherent trade plan could be derived from this data.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlanCell label="Side" value={levels.side.toUpperCase()} />
        <PlanCell
          label="Entry zone"
          value={`${levels.entryZoneLow.toFixed(2)} – ${levels.entryZoneHigh.toFixed(2)}`}
        />
        <PlanCell label="Invalidation" value={levels.invalidation.toFixed(2)} />
        <PlanCell label="Stop loss" value={levels.stopLoss.toFixed(2)} tone="negative" />
        <PlanCell label="TP1" value={levels.takeProfit1.toFixed(2)} tone="positive" />
        <PlanCell label="TP2" value={levels.takeProfit2.toFixed(2)} tone="positive" />
        <PlanCell label="TP3" value={levels.takeProfit3.toFixed(2)} tone="positive" />
        <PlanCell
          label="Risk / reward"
          value={levels.riskReward === null ? "—" : `1 : ${levels.riskReward.toFixed(2)}`}
        />
      </div>

      {sizing ? (
        <div className="grid grid-cols-2 gap-2 border-t border-black/5 pt-2 sm:grid-cols-4 dark:border-white/5">
          <PlanCell label="Quantity" value={sizing.tradeable ? String(sizing.quantity) : "0"} />
          <PlanCell label="Notional" value={sizing.notional.toFixed(2)} />
          <PlanCell
            label="Max loss (incl. costs)"
            value={sizing.maximumLoss.toFixed(2)}
            tone="negative"
          />
          <PlanCell label="Leverage" value={`${sizing.leverage.toFixed(2)}×`} />
        </div>
      ) : null}

      {sizing && !sizing.tradeable ? (
        <p className="text-[11px] text-red-600 dark:text-red-400">{sizing.reason}</p>
      ) : null}

      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-text-muted">
        {levels.rationale.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
        {sizing?.warnings.map((line, i) => (
          <li key={`w-${i}`} className="text-yellow-600 dark:text-yellow-400">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StructureTab({ analysis }: { analysis: AnalysisView }) {
  const structure = analysis.structure;
  if (!structure) return <p className="text-xs text-text-muted">No structure available.</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="info" size="sm">
          {structure.trend}
        </Badge>
        <span className="text-[11px] text-text-muted">
          strength {(structure.trendStrength * 100).toFixed(0)}%
        </span>
        <Badge variant="neutral" size="sm">
          volatility: {structure.volatility}
        </Badge>
        {structure.atrPercent !== null ? (
          <span className="text-[11px] text-text-muted">
            ATR {(structure.atrPercent * 100).toFixed(2)}% of price
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <LevelList title="Resistance" levels={structure.resistance} />
        <LevelList title="Support" levels={structure.support} />
      </div>

      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-text-muted">
        {structure.rationale.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function MtfTab({ analysis }: { analysis: AnalysisView }) {
  const mtf = analysis.mtf;
  if (!mtf) {
    return (
      <p className="text-xs text-text-muted">
        Add more timeframes to the request to enable multi-timeframe analysis.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant={mtf.alignment === "conflicted" ? "warning" : "info"} size="sm">
          {mtf.alignment.replace(/_/g, " ")}
        </Badge>
        <span className="text-[11px] text-text-muted">
          aggregate bias {mtf.aggregateBias.toFixed(2)}
        </span>
      </div>
      <p className="text-[11.5px] font-medium">{mtf.narrative}</p>

      <div className="flex flex-col gap-1">
        {mtf.views.map((view) => (
          <div key={view.timeframe} className="flex items-start gap-2">
            <span className="w-10 shrink-0 font-mono text-[10px] uppercase">{view.timeframe}</span>
            <Badge
              variant={
                view.trend === "uptrend"
                  ? "success"
                  : view.trend === "downtrend"
                    ? "danger"
                    : "neutral"
              }
              size="sm"
            >
              {view.trend}
            </Badge>
            <span className="text-[10.5px] leading-snug text-text-muted">{view.evidence}</span>
          </div>
        ))}
      </div>

      {mtf.conflicts.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-yellow-600 dark:text-yellow-400">
          {mtf.conflicts.map((conflict, i) => (
            <li key={i}>{conflict}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function LevelList({
  title,
  levels,
}: {
  title: string;
  levels: { price: number; touches: number }[];
}) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{title}</span>
      {levels.length === 0 ? (
        <p className="text-[11px] text-text-muted">None detected.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {levels.map((level, i) => (
            <li key={i} className="flex items-center justify-between font-mono text-[11px]">
              <span>{level.price.toFixed(2)}</span>
              <span className="text-text-muted">
                {level.touches} touch{level.touches === 1 ? "" : "es"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanCell({
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
      <span className={`font-mono text-xs font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}
