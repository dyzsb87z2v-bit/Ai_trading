"use client";

/**
 * AI Copilot panel (master spec §9, §34, §36, §37).
 *
 * Shows the signal score, the factors that produced it, the trade plan and the
 * "why buy / why sell / why wait" explanation.
 *
 * The score bar is deliberately labelled "factor agreement", never "confidence"
 * or "win probability" — §8 forbids presenting an uncalibrated number as a
 * probability of success.
 */

import { Badge, Button, Card, type BadgeVariant } from "@/components/ui";
import type { AnalysisView } from "./types";

interface CopilotPanelProps {
  analysis: AnalysisView | null;
  copilotText: string | null;
  copilotLoading: boolean;
  copilotError: string | null;
  onAskCopilot: () => void;
}

function stateVariant(state: string): BadgeVariant | "info" {
  if (state === "STRONG_BUY" || state === "BUY") return "success";
  if (state === "STRONG_SELL" || state === "SELL") return "danger";
  if (state === "NO_TRADE") return "danger";
  if (state === "WAIT" || state === "HOLD") return "warning";
  return "neutral";
}

function severityVariant(severity: string): BadgeVariant {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

export function CopilotPanel({
  analysis,
  copilotText,
  copilotLoading,
  copilotError,
  onAskCopilot,
}: CopilotPanelProps) {
  if (!analysis) {
    return (
      <Card title="AI Copilot" padding="sm">
        <p className="text-xs text-text-muted">Run an analysis to see the Copilot read.</p>
      </Card>
    );
  }

  const signal = analysis.signal;

  return (
    <div className="flex flex-col gap-3">
      <Card title="Signal" padding="sm">
        {signal ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Badge variant={stateVariant(signal.state)} size="lg">
                {signal.state.replace(/_/g, " ")}
              </Badge>
              <span className="font-mono text-2xl font-bold">{signal.score.toFixed(0)}</span>
              <span className="text-xs text-text-muted">/ 100</span>
              <Badge variant="neutral" size="sm">
                Grade {signal.grade}
              </Badge>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] text-text-muted">
                {/* Never call this a probability of profit (§8). */}
                <span>Factor agreement (not a win probability)</span>
                <span className="font-mono">{(signal.agreement * 100).toFixed(0)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(signal.agreement * 100)}%` }}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-text-muted">
                Score factors
              </span>
              {signal.factors.map((factor) => (
                <div key={factor.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-medium">{factor.label}</span>
                    <span
                      className={`font-mono ${
                        factor.value > 0
                          ? "text-green-600 dark:text-green-400"
                          : factor.value < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-text-muted"
                      }`}
                    >
                      {factor.value > 0 ? "+" : ""}
                      {factor.value.toFixed(2)} × {factor.weight.toFixed(2)}
                    </span>
                  </div>
                  {/* A bipolar bar: centre is neutral, direction is the sign. */}
                  <div className="relative h-1 w-full rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className={`absolute top-0 h-full rounded-full ${
                        factor.value >= 0 ? "bg-green-500" : "bg-red-500"
                      }`}
                      style={{
                        left: factor.value >= 0 ? "50%" : `${50 + factor.value * 50}%`,
                        width: `${Math.abs(factor.value) * 50}%`,
                      }}
                    />
                  </div>
                  <p className="text-[10px] leading-snug text-text-muted">{factor.evidence}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-muted">No signal could be computed.</p>
        )}
      </Card>

      {analysis.warnings.length > 0 ? (
        <Card title="Warnings" padding="sm">
          <div className="flex flex-col gap-1.5">
            {analysis.warnings.map((warning, i) => (
              <div key={`${warning.code}-${i}`} className="flex items-start gap-2">
                <Badge variant={severityVariant(warning.severity)} size="sm">
                  {warning.severity}
                </Badge>
                <span className="text-[11px] leading-snug">{warning.message}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {signal ? (
        <Card title="Reasoning" padding="sm">
          <pre className="whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-text-muted">
            {signal.explanation}
          </pre>
        </Card>
      ) : null}

      <Card
        title="Copilot narrative"
        padding="sm"
        action={
          <Button size="sm" variant="secondary" onClick={onAskCopilot} disabled={copilotLoading}>
            {copilotLoading ? "Asking…" : "Ask Copilot"}
          </Button>
        }
      >
        {copilotError ? (
          <p className="text-[11px] text-red-600 dark:text-red-400">{copilotError}</p>
        ) : copilotText ? (
          <pre className="whitespace-pre-wrap text-[11px] leading-relaxed">{copilotText}</pre>
        ) : (
          <p className="text-[11px] text-text-muted">
            The Copilot receives only the computed evidence above and explains it. It cannot
            introduce a price, level or statistic that is not already on this page.
          </p>
        )}
      </Card>
    </div>
  );
}
